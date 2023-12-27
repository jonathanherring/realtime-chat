import dotenv from "dotenv";
import fastify from "fastify";
import fastifyCors from '@fastify/cors';
import fastifySocketIO from 'fastify-socket.io'
import Redis from 'ioredis';
import closeWithGrace from 'close-with-grace';
import { randomUUID } from "crypto";

dotenv.config();


const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL

const CONNECTION_COUNT_KEY = "chat:connection-count";
const CONNECTION_COUNT_UPDATED_CHANNEL = "chat:connection-count-updated";
const NEW_MESSAGE_CHANNEL = "chat:new-message";



if (!UPSTASH_REDIS_REST_URL) {
    console.error("UPSTASH_REDIS_REST_URL is required")
    process.exit(1);
}
const publisher = new Redis(UPSTASH_REDIS_REST_URL)
const subscriber = new Redis(UPSTASH_REDIS_REST_URL)

let connectedClients = 0

async function buildServer() {
    const app = fastify();
    //Register cors when building server, otherwise likely to forget and run into issues
    //await so 
    await app.register(fastifyCors, {
        origin: CORS_ORIGIN,
    });

    await app.register(fastifySocketIO)

    const currentCount = await publisher.get(CONNECTION_COUNT_KEY)

    if (currentCount !== null) {
        // Parse the count from Redis and update the global variable
        connectedClients = parseInt(currentCount, 10);
      } else {
        // If the count is not in Redis, set it to 0
        await publisher.set(CONNECTION_COUNT_KEY, 0);
      }

    //using await, connection callback needs to be async
    app.io.on('connection', async (io) => {
        console.log("Client Connecte");
        
        const incResult = await publisher.incr(CONNECTION_COUNT_KEY);

        connectedClients++;
        console.log("connectedClients", connectedClients);

        await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, String(incResult));

        io.on(NEW_MESSAGE_CHANNEL, async (payload) => {

            const message = payload.message

            if(!message){
                return;
            }
            console.log("rest", message);
            await publisher.publish(NEW_MESSAGE_CHANNEL, message.toString());
        })

        io.on('disconnect', async () => {
            console.log("Client Disconnected");
            connectedClients--;
            const decResult = await publisher.decr(CONNECTION_COUNT_KEY);
            await publisher.publish(CONNECTION_COUNT_UPDATED_CHANNEL, String(decResult));
        })
    })

    subscriber.subscribe(CONNECTION_COUNT_UPDATED_CHANNEL, (error, count) => {
        if(error) {
            console.error(`error subscribing to ${CONNECTION_COUNT_UPDATED_CHANNEL}`, error 
            );
            return
        }
        console.log(`${count} clients connected to ${CONNECTION_COUNT_UPDATED_CHANNEL} channel`)
    });

    subscriber.subscribe(NEW_MESSAGE_CHANNEL, (error, count) => {
        if(error) {
            console.error(`error subscribing to ${NEW_MESSAGE_CHANNEL}`, error 
            );
            return
        }

        console.log(`${count} clients subscribed to ${NEW_MESSAGE_CHANNEL} channel`)
    });

    subscriber.on('message', (channel, text) => {
        if(channel===CONNECTION_COUNT_UPDATED_CHANNEL) {
            app.io.emit(CONNECTION_COUNT_UPDATED_CHANNEL, {
                count: text
            })
            return
        }

        if(channel===NEW_MESSAGE_CHANNEL) {
            app.io.emit(NEW_MESSAGE_CHANNEL, {
                message: text,
                id: randomUUID(),
                createdAt: new Date().toISOString(),
                port: PORT,
            })
            return
        }
    })

    app.get('/healthcheck', () => {
        return {
            status: 'ok',
            port: PORT,
        };
    })

    return app
}

async function main() {
    const app = await buildServer();

    try {
        await app.listen({
            port: PORT,
            host: HOST
        });


        closeWithGrace({ delay: 5000 }, async ({signal, err}) => {
            console.log('Server is closing', connectedClients);
            console.log({ err, signal});

             if(connectedClients > 0){
                console.log(`Removing ${connectedClients} from the count`);

                const currentCount = parseInt(await publisher.get(CONNECTION_COUNT_KEY) || '0', 10);
                //Wrap in Math.max to prevent from going negative
                const newCount = Math.max(currentCount - connectedClients, 0);
                await publisher.set(CONNECTION_COUNT_KEY, newCount);
             }


            await app.close();

            console.log('Server closed');
        })
        console.log(`Server listening on ${HOST}:${PORT}`)
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}


main();