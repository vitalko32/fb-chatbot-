import fs from 'fs';
import https from 'https';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import Redis from 'ioredis';
import { config as envConfig } from 'dotenv-safe';
envConfig();
import Persona from './persona.js';


const app = express();

const redisClient = new Redis();

app.use(bodyParser.urlencoded({extended: false}));
app.use(bodyParser.json());

const httpsOptions = {
    key: fs.readFileSync('/home/admin/web/git.neiro.network/public_html/fb/key.pem'),
    cert: fs.readFileSync('/home/admin/web/git.neiro.network/public_html/fb/certificate.pem')
};

https.createServer(httpsOptions, app).listen(process.env.port, () => {
    console.log(`\n--- Server is live and listening on port ${process.env.port}! ---\n`);
});

// Facebook Page Access Token
let token = process.env.fbPageToken;

// Root route. Useful for checking bot status.
app.get('/', function (req, res) {
    res.send('Chatbot is running!');
});

// Webhook setup
app.get('/webhook/', function (req, res) {
    if (req.query['hub.verify_token'] === process.env.fbVerifyToken) {
        console.log('Got correct token for webhook get request');
        return res.send(req.query['hub.challenge']);
    }
    console.error('Got wrong verify token in webhook get request');
    return res.send('Error: Wrong token.');
});

// Post message to Facebook
async function sendTextMessage(sender, text) {

    const requestData = {
        recipient: {id: sender},
        message: {text: text},
    };

    console.log('Got message request!');
    console.log(requestData);

    try {
        await axios.post(`https://graph.facebook.com/v16.0/me/messages?access_token=${token}`, requestData);
    } catch (error) {
        console.error('Error sending messages:', error);
    }

}

// Send indicator that a message is being typed
async function sendTypingIndicator(sender, typingState) {

    try {
        await axios.post(`https://graph.facebook.com/v16.0/me/messages?access_token=${token}`, {
            recipient: {id: sender},
            sender_action: typingState ? "typing_on" : "typing_off",
        });
    } catch (error) {
        console.error('Error sending typing indicator:', error);
    }

}

async function sendSeen(sender) {

    try {
        await axios.post(`https://graph.facebook.com/v16.0/me/messages?access_token=${token}`, {
            recipient: {id: sender},
            sender_action: 'mark_seen',
        });
    } catch (error) {
        console.error('Error with seen indicator:', error);
    }

}

async function flushUserData(sender) {
    const userKeys = [
        `userMessages:${sender}`,
        `userTimeout:${sender}`,
        `persona:${sender}`,
        `activeUsers:${sender}`,
        `reminderSent:${sender}`,
        `userLastMessageTime:${sender}`,
    ];

    userKeys.forEach((key) => {
        redisClient.del(key, (err) => {
            if (err) {
                console.error(`Error deleting key ${key}:`, err);
            } else {
                console.log(`Successfully deleted key ${key}`);
            }
        });
    });
}

async function checkScheduledMessages() {
    redisClient.smembers('activeUsers', async (err, users) => {
        if (err) {
            console.error('Error getting active users:', err);
        } else {
            for (const user of users) {
                redisClient.get(`userLastMessageTime:${user}`, async (err, lastMessageTime) => {
                    if (err) {
                        console.error('Error getting last message time:', err);
                    } else {
                        const timeSinceLastMessage = Date.now() - lastMessageTime;
                        const twentyFourHours = 24 * 60 * 60 * 1000;

                        if (timeSinceLastMessage >= twentyFourHours) {
                            redisClient.get(`reminderSent:${user}`, async (err, reminderSent) => {
                                if (err) {
                                    console.error('Error getting reminderSent flag:', err);
                                } else if (!reminderSent) {
                                    await sendTypingIndicator(user, true);
                                    sendTextMessage(user, "It's been 24 hours since our last conversation. If you have any new dreams to share, feel free to tell me!");
                                    redisClient.set(`reminderSent:${user}`, 'true');
                                }
                            });
                        }
                    }
                });
            }
        }
    });
}


setInterval(checkScheduledMessages, 60 * 60 * 1000); // 1 hour in milliseconds


// Handle incoming messages
app.post('/webhook/', async function (req, res) {
    let messaging_events = req.body.entry[0].messaging;
    for (let i = 0; i < messaging_events.length; i++) {

        let event = messaging_events[i];
        let sender = event.sender.id;

        if (event.message && event.message.text && !event.message.app_id && !event.message.text.startsWith('/bot')) {

            let userMessagesKey = `userMessages:${sender}`;
            let userTimeoutKey = `userTimeout:${sender}`;

            redisClient.setnx(userMessagesKey, event.message.text + "\n ", (err, result) => {
                console.log("Result of setting Not eXists key:", result); // 1 if the key was set, 0 if the key already exists
                if (result == 0) {
                    // Append new message to userMessages
                    redisClient.append(userMessagesKey, event.message.text + "\n ");
                }
            });

            // Debug
            console.log('Added text:', event.message.text);
            redisClient.get(userMessagesKey, async (err, messagez) => {
                console.log('Now text become:', messagez);
            });

            redisClient.sadd('activeUsers', sender);
            console.log('User added to activeUsers set:', sender);

            redisClient.set(`reminderSent:${sender}`, 'false');

            // Check if the user has a persona and send a welcome message if not
            redisClient.exists(`persona:${sender}`, async (err, exists) => {
                if (!exists) {
                    try {

                        redisClient.set(userMessagesKey, event.message.text + "\n ", (err, result) => {
                            if (err) {
                              console.error('Error setting userMessagesKey value for the key:', err);
                            } else {
                              console.log("Result of setting text:", result); // 'OK' if the operation is successful
                            }
                        });

                        redisClient.set(`persona:${sender}`, "guru"); //setting hardcoded default name
                        await sendSeen(sender);
                        await sendTypingIndicator(sender, true);
                        sendTextMessage(sender, `Hi! 👋 I am a Dream Interpreter to explain your dream. Tell me your dream.`);
                    } catch (err) {
                        sendTextMessage(sender, 'Failed to start a bot: ' + err.message);
                    }
                }
            });

            redisClient.exists(userTimeoutKey, (err, exists) => {
                if (!exists) {
                    setTimeout(async () => {
                        redisClient.get(userMessagesKey, async (err, messages) => {
                            if (!err) {
                                await sendSeen(sender);
                                await sendTypingIndicator(sender, true);

                                // redisClient.get(`persona:${sender}`, async (err, personaData) => {
                                //     if (err) {
                                //       sendTextMessage(sender, 'Failed to get the chatbot: ' + err.message);
                                //     } else {
                                //       const chatbot = new Persona(personaData);
                                //     }
                                // });
                                const chatbot = new Persona("guru", { name: "Dream Interpreter" });
                                const gptResponse = await chatbot.sendMessage(messages);
                                sendTextMessage(sender, gptResponse);

                                // Reset user messages and timeout
                                redisClient.del(userMessagesKey);
                                messages = null;
                                redisClient.del(userTimeoutKey);

                                return res.sendStatus(200);
                            }
                        });
                    }, 120000); // 2 minutes in milliseconds
                }
            });

            if (!await redisClient.get(userTimeoutKey)) {
                redisClient.set(userTimeoutKey, 'true', 'EX', 120);
            }
        }


        // Bot Commands

        // If the user sent the "new" command, trash the current instance and create a new one
        if (event.message.text.startsWith('/bot:new')) {
            const newPersona = event.message.text.split(' ')[1] || 'default';
            try {
                redisClient.set(`persona:${sender}`, newPersona);
                await sendSeen(sender);
                await sendTypingIndicator(sender, true);
                sendTextMessage(sender, `Hi! 👋 I am a dream interpreter with the "${newPersona}" personality to explain your dream. Tell me your dream.`);
            } catch (err) {
                sendTextMessage(sender, 'Failed to start a bot: ' + err.message);
            }
            return res.sendStatus(200);
        }

        if (event.message.text === '/bot:flush') {
            flushUserData(sender);
            console.log("User Redis data flushed");
            return res.sendStatus(200);
        }

        // If the user sent the "reset" command, reset the instance
        if (event.message.text === '/bot:reset') {
            sendTextMessage(sender, await chatbot.reset());
            return res.sendStatus(200);
        }

        // If the user sent the "debug" command, output the Persona's state as a stringified JSON object
        if (event.message.text.startsWith('/bot:debug ')) {
            sendTextMessage(sender, await chatbot.debug(event.message.text.split(' ')[1]));
            return res.sendStatus(200);
        }

        // If the user sent the "func" command, execute the specified function in the current instance
        if (event.message.text.startsWith('/bot:func ')) {
            sendTextMessage(sender, await chatbot.func(event.message.text.split(' ')[1]));
            return res.sendStatus(200);
        }

        // If the user sent the "rewind" command, we can rewind the chat by the number of turns provided
        if (event.message.text.startsWith('/bot:rewind ')) {
            const turnsToRewind = parseInt(event.message.text.split(' ')[1]);
            if (isNaN(turnsToRewind)) throw new Error('The rewind command requires a valid integer with the number of turns to rewind');
            sendTextMessage(sender, await chatbot.rewind(turnsToRewind));
            return res.sendStatus(200);
        }
    }
});
