const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const readline = require('readline');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const { Client: FNClient } = require('fnbr');
const axios = require('axios');
const { URL } = require('url');
const ip = require('ip');
const express = require('express');
const colors = require('colors');

// Configuration
const config = {
    fortniteApiKey: 'c10c52a8-6f28-402c-974c-51bc813251bb',
    defaultCosmetics: {
        outfit: 'CID_028_Athena_Commando_F', // Renegade Raider
        backpack: 'BID_004_BlackKnight', // Black Knight Shield
        emote: 'EID_Floss', // Floss
        level: 200
    },
    httpPort: 3000,
    maxPortAttempts: 10, // Try up to 10 ports if the default is in use
    dbFile: 'cosmetics.db',
    deviceAuthFile: 'deviceauth.json',
    autoAcceptFriendRequests: true,
    autoAcceptPartyInvitations: true
};

// Create device auth input handler
function createAuthInputHandler() {
    return new Promise((resolve) => {
        if (fs.existsSync(config.deviceAuthFile)) {
            try {
                const deviceAuth = JSON.parse(fs.readFileSync(config.deviceAuthFile));
                logger.info('Device authentication found, using saved credentials');
                return resolve(deviceAuth);
            } catch (error) {
                logger.error(`Failed to parse device auth file: ${error.message}`);
                // Continue to manual input if file parse fails
                if (fs.existsSync(config.deviceAuthFile)) {
                    fs.unlinkSync(config.deviceAuthFile);
                    logger.info('Removed invalid device auth file');
                }
            }
        }
        
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        logger.info('No stored authentication found. Please enter your details:');
        
        rl.question(colors.yellow('Enter AccountId: '), (accountId) => {
            rl.question(colors.yellow('Enter Secret: '), (secret) => {
                rl.question(colors.yellow('Enter DeviceId: '), (deviceId) => {
                    rl.close();
                    
                    const auth = { accountId, secret, deviceId };
                    
                    // Save to file for future use
                    fs.writeFileSync(config.deviceAuthFile, JSON.stringify(auth, null, 2));
                    logger.success('Authentication saved to deviceauth.json');
                    
                    resolve(auth);
                });
            });
        });
    });
}

// State
let fnClient = null;
let db = null;
let cosmetics = [];
let isDbInitialized = false;
let isClientReady = false;
let connectedClients = new Set();

// Logger utility
const logger = {
    info: (message) => console.log(`[${getTimestamp()}] ${colors.cyan('INFO')} ${message}`),
    success: (message) => console.log(`[${getTimestamp()}] ${colors.green('SUCCESS')} ${message}`),
    warn: (message) => console.log(`[${getTimestamp()}] ${colors.yellow('WARNING')} ${message}`),
    error: (message) => console.log(`[${getTimestamp()}] ${colors.red('ERROR')} ${message}`),
    debug: (message) => console.log(`[${getTimestamp()}] ${colors.magenta('DEBUG')} ${message}`)
};

// Helper function to get formatted timestamp
function getTimestamp() {
    return new Date().toLocaleTimeString();
}

// Initialize database
function initializeDatabase() {
    return new Promise((resolve, reject) => {
        logger.info('Initializing database...');
        
        db = new sqlite3.Database(config.dbFile, (err) => {
            if (err) {
                logger.error(`Failed to open database: ${err.message}`);
                return reject(err);
            }
            
            db.run(`
                CREATE TABLE IF NOT EXISTS cosmetics (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL,
                    rarity TEXT NOT NULL,
                    icon TEXT NOT NULL,
                    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `, (err) => {
                if (err) {
                    logger.error(`Failed to create table: ${err.message}`);
                    return reject(err);
                }
                
                // Create variants table if it doesn't exist
                db.run(`
                    CREATE TABLE IF NOT EXISTS cosmetic_variants (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        cosmetic_id TEXT NOT NULL,
                        channel TEXT NOT NULL,
                        tag TEXT NOT NULL,
                        name TEXT NOT NULL,
                        image TEXT,
                        FOREIGN KEY (cosmetic_id) REFERENCES cosmetics(id),
                        UNIQUE(cosmetic_id, channel, tag)
                    )
                `, (err) => {
                    if (err) {
                        logger.error(`Failed to create variants table: ${err.message}`);
                        return reject(err);
                    }
                    
                    isDbInitialized = true;
                    logger.success('Database initialized successfully');
                    resolve();
                });
            });
        });
    });
}

// Handle client ready event
async function handleClientReady() {
    logger.success(`Fortnite client ready! Logged in as ${fnClient.user?.displayName || 'Unknown User'}`);
    
    isClientReady = true;
    
    // Set default cosmetics
    try {
        logger.info('Setting up default cosmetics and level...');
        
        // Set default outfit (Renegade Raider)
        await fnClient.party.me.setOutfit(config.defaultCosmetics.outfit);
        
        // Set default backpack (Black Knight Shield)
        await fnClient.party.me.setBackpack(config.defaultCosmetics.backpack);
        
        // Set default emote (Floss)
        await fnClient.party.me.setEmote(config.defaultCosmetics.emote);
        
        // Set default level
        await fnClient.party.me.setLevel(config.defaultCosmetics.level);
        
        logger.success('Default cosmetics and level applied');
        
        // Setup status rotation
        setupStatusRotation();
        
        // Broadcast client info to all connected web clients
        broadcastBotInfo();
    } catch (error) {
        logger.error(`Failed to set default cosmetics: ${error.message}`);
    }
}

// Handle friend request event
async function handleFriendRequest(request) {
    if (config.autoAcceptFriendRequests) {
        try {
            await request.accept();
            logger.success(`Accepted friend request from ${request.displayName}`);
            
            // Broadcast to web clients
            broadcastToWebClients({
                type: 'friendRequest',
                request: {
                    id: request.id,
                    displayName: request.displayName,
                    accepted: true
                }
            });
            
            // Update friends list for all clients
            broadcastFriendsList();
        } catch (error) {
            logger.error(`Failed to accept friend request: ${error.message}`);
        }
    } else {
        logger.info(`Received friend request from ${request.displayName} (Auto-accept disabled)`);
        
        // Broadcast to web clients
        broadcastToWebClients({
            type: 'friendRequest',
            request: {
                id: request.id,
                displayName: request.displayName,
                accepted: false
            }
        });
    }
}

// Handle friend message event
async function handleFriendMessage(message) {
    logger.info(`Message from ${message.author.displayName}: ${message.content}`);
    
    // Broadcast to web clients
    broadcastToWebClients({
        type: 'message',
        message: {
            senderId: message.author.id,
            senderName: message.author.displayName,
            content: message.content,
            timestamp: new Date().toISOString()
        }
    });
    
    // You could add auto-responses here
    // await message.author.sendMessage('Thanks for your message!');
}

// Handle party invite event
async function handlePartyInvite(invitation) {
    if (config.autoAcceptPartyInvitations) {
        try {
            await invitation.accept();
            logger.success(`Accepted party invitation from ${invitation.sender.displayName}`);
            
            // Broadcast to web clients
            broadcastToWebClients({
                type: 'partyInvite',
                invite: {
                    id: invitation.id,
                    displayName: invitation.sender.displayName,
                    accepted: true
                }
            });
        } catch (error) {
            logger.error(`Failed to accept party invitation: ${error.message}`);
        }
    } else {
        logger.info(`Received party invitation from ${invitation.sender.displayName} (Auto-accept disabled)`);
        
        // Broadcast to web clients
        broadcastToWebClients({
            type: 'partyInvite',
            invite: {
                id: invitation.id,
                displayName: invitation.sender.displayName,
                accepted: false
            }
        });
    }
}

// Handle party member joined event
async function handlePartyMemberJoined(member) {
    logger.info(`${member.displayName} joined the party`);
    
    // You can add custom welcome actions here
    // await fnClient.party.sendMessage(`Welcome to the party, ${member.displayName}!`);
}

// Handle friend status change event
async function handleFriendStatus(friend, status) {
    logger.info(`${friend.displayName} is now ${status}`);
    
    // Broadcast updated friends list to web clients
    broadcastFriendsList();
}

// Fetch and update cosmetics from Fortnite API
async function fetchAndUpdateCosmetics() {
    if (!isDbInitialized) {
        logger.error('Cannot update cosmetics: Database not initialized');
        return;
    }
    
    logger.info('Fetching cosmetics from Fortnite API...');
    
    try {
        // Make request to fortnite-api.com
        const response = await axios.get('https://fortnite-api.com/v2/cosmetics/br', {
            headers: {
                'Authorization': config.fortniteApiKey
            }
        });
        
        if (!response.data || !response.data.data) {
            logger.error('Invalid response from Fortnite API');
            return;
        }
        
        const apiCosmetics = response.data.data;
        logger.success(`Retrieved ${apiCosmetics.length} cosmetics from API`);
        
        // Begin database transaction for better performance
        await runDbTransaction(async () => {
            let addedCount = 0;
            let updatedCount = 0;
            let skippedCount = 0;
            
            for (const item of apiCosmetics) {
                // Skip cosmetics without an ID, name, or icon
                if (!item.id || !item.name || !item.images || !item.images.icon) {
                    skippedCount++;
                    continue;
                }
                
                // Map API types to simplified types
                let type = 'other';
                if (item.type) {
                    const typeMap = {
                        'outfit': 'outfit',
                        'backpack': 'backpack',
                        'pickaxe': 'pickaxe',
                        'emote': 'emote',
                        'glider': 'glider',
                        'wrap': 'wrap',
                        'contrail': 'contrail',
                        'loadingscreen': 'loadingscreen',
                        'music': 'music'
                    };
                    
                    type = typeMap[item.type.value.toLowerCase()] || 'other';
                }
                
                try {
                    // Check if cosmetic already exists
                    const existing = await getDbCosmetic(item.id);
                    
                    if (existing) {
                        // Update existing cosmetic
                        await updateDbCosmetic(
                            item.id,
                            item.name,
                            type,
                            item.rarity?.value || 'common',
                            item.images.icon
                        );
                        updatedCount++;
                    } else {
                        // Add new cosmetic
                        await insertDbCosmetic(
                            item.id,
                            item.name,
                            type,
                            item.rarity?.value || 'common',
                            item.images.icon
                        );
                        addedCount++;
                    }
                } catch (error) {
                    logger.error(`Failed to process cosmetic ${item.id}: ${error.message}`);
                    skippedCount++;
                }
            }
            
            logger.success(`Cosmetics database updated: ${addedCount} added, ${updatedCount} updated, ${skippedCount} skipped`);
        });
        
        // Load cosmetics into memory
        await loadCosmeticsFromDb();
    } catch (error) {
        logger.error(`Failed to fetch cosmetics: ${error.message}`);
    }
}

// Load cosmetics from database into memory
async function loadCosmeticsFromDb() {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM cosmetics ORDER BY name ASC', [], (err, rows) => {
            if (err) {
                logger.error(`Failed to load cosmetics from database: ${err.message}`);
                return reject(err);
            }
            
            cosmetics = rows;
            logger.success(`Loaded ${cosmetics.length} cosmetics from database`);
            resolve(cosmetics);
        });
    });
}

// Database helper: Run a transaction
async function runDbTransaction(callback) {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('BEGIN TRANSACTION');
            
            try {
                const result = callback();
                
                if (result instanceof Promise) {
                    result.then(() => {
                        db.run('COMMIT', (err) => {
                            if (err) {
                                db.run('ROLLBACK');
                                reject(err);
                            } else {
                                resolve();
                            }
                        });
                    }).catch((err) => {
                        db.run('ROLLBACK');
                        reject(err);
                    });
                } else {
                    db.run('COMMIT', (err) => {
                        if (err) {
                            db.run('ROLLBACK');
                            reject(err);
                        } else {
                            resolve();
                        }
                    });
                }
            } catch (err) {
                db.run('ROLLBACK');
                reject(err);
            }
        });
    });
}

// Database helper: Get a cosmetic by ID
function getDbCosmetic(id) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM cosmetics WHERE id = ?', [id], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// Database helper: Insert a new cosmetic
function insertDbCosmetic(id, name, type, rarity, icon) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO cosmetics (id, name, type, rarity, icon) VALUES (?, ?, ?, ?, ?)',
            [id, name, type, rarity, icon],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

// Database helper: Update an existing cosmetic
function updateDbCosmetic(id, name, type, rarity, icon) {
    return new Promise((resolve, reject) => {
        db.run(
            'UPDATE cosmetics SET name = ?, type = ?, rarity = ?, icon = ? WHERE id = ?',
            [name, type, rarity, icon, id],
            function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
}

// Initialize Fortnite client
async function initializeFortniteClient(auth) {
    logger.info('Initializing Fortnite client...');
    
    try {
        fnClient = new FNClient({
            auth: {
                deviceAuth: auth
            },
            defaultStatus: 'SaphyreFN - The Best Fortnite Bot',
            platform: 'WIN',
            keepAliveInterval: 30,
            debug: false,
            partyConfig: {}
        });

        // Set up event handlers
        fnClient.on('ready', handleClientReady);
        fnClient.on('friend:request', handleFriendRequest);
        fnClient.on('friend:message', handleFriendMessage);
        fnClient.on('party:invite', handlePartyInvite);
        fnClient.on('party:member:joined', handlePartyMemberJoined);
        fnClient.on('friend:status', handleFriendStatus);

        // Login
        await fnClient.login();
        logger.success(`Logged in as ${fnClient.user.displayName}`);
        
        return fnClient;
    } catch (error) {
        logger.error(`Failed to login: ${error.message}`);
        logger.debug(`Login error stack: ${error.stack}`);
        
        // Don't exit process, allow for manual credentials re-entry
        if (fs.existsSync(config.deviceAuthFile)) {
            fs.unlinkSync(config.deviceAuthFile);
            logger.info('Removed invalid device auth file. Please restart and enter your credentials again.');
        }
        throw error; // Propagate error instead of exiting
    }
}

// WebSocket server message handler
function handleWebSocketMessage(ws, message) {
    try {
        const data = JSON.parse(message);
        
        // Add ping support for connection monitoring
        if (data.type === 'ping') {
            ws.send(JSON.stringify({ type: 'pong' }));
            return;
        }
        
        // Check if client is ready before performing client-dependent operations
        if (!isClientReady && ['setCosmetic', 'setLevel', 'inviteFriend', 'removeFriend', 'sendMessage', 'stopEmote', 'setStatus', 'checkCosmeticVariants', 'setOutfitWithVariants'].includes(data.type)) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Bot is not fully connected yet',
                messageType: 'error'
            }));
            return;
        }
        
        switch (data.type) {
            case 'getBotInfo':
                sendBotInfo(ws);
                break;
                
            case 'getCosmetics':
                sendCosmetics(ws);
                break;
                
            case 'getFriends':
                sendFriendsList(ws);
                break;
                
            case 'setCosmetic':
                handleSetCosmetic(ws, data);
                break;
                
            case 'stopEmote':
                handleStopEmote(ws);
                break;
                
            case 'outfit':
            case 'backpack':
            case 'emote':
            case 'pickaxe':
                // Handle legacy format messages for cosmetic types
                handleSetCosmetic(ws, { id: data.id, type: data.type });
                break;
                
            case 'setLevel':
                handleSetLevel(ws, data);
                break;
                
            case 'refreshCosmetics':
                handleRefreshCosmetics(ws);
                break;
                
            case 'acceptAllFriends':
                handleAcceptAllFriends(ws);
                break;
                
            case 'rebootBot':
                handleRebootBot(ws);
                break;
                
            case 'changeAccount':
                handleChangeAccount(ws);
                break;
                
            case 'inviteFriend':
                handleInviteFriend(ws, data);
                break;
                
            case 'removeFriend':
                handleRemoveFriend(ws, data);
                break;
                
            case 'sendMessage':
                handleSendMessage(ws, data);
                break;
                
            case 'setStatus':
                handleSetStatus(ws, data);
            
            case 'checkCosmeticVariants':
                handleCheckCosmeticVariants(ws, data);
                break;
                
            case 'setOutfitWithVariants':
                handleSetOutfitWithVariants(ws, data);
                break;
                
            default:
                logger.warn(`Unknown WebSocket message type: ${data.type}`);
                ws.send(JSON.stringify({
                    type: 'notification',
                    message: 'Unknown command',
                    messageType: 'error'
                }));
        }
    } catch (error) {
        logger.error(`Failed to handle WebSocket message: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Invalid message format',
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Send bot info
function sendBotInfo(ws) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'botInfo',
            info: {
                displayName: 'Not connected',
                level: 'N/A',
                friendCount: 0,
                status: 'Offline'
            }
        }));
        return;
    }
    
    ws.send(JSON.stringify({
        type: 'botInfo',
        info: {
            displayName: fnClient.user?.displayName || 'Unknown',
            level: fnClient.party?.me?.level || config.defaultCosmetics.level,
            friendCount: fnClient.friends?.size || 0,
            status: 'Online'
        }
    }));
}

// WebSocket handler: Broadcast bot info to all clients
function broadcastBotInfo() {
    if (!isClientReady || !fnClient) return;
    
    broadcastToWebClients({
        type: 'botInfo',
        info: {
            displayName: fnClient.user?.displayName || 'Unknown',
            level: fnClient.party?.me?.level || config.defaultCosmetics.level,
            friendCount: fnClient.friends?.size || 0,
            status: 'Online'
        }
    });
}

// WebSocket handler: Send cosmetics list
function sendCosmetics(ws) {
    ws.send(JSON.stringify({
        type: 'cosmetics',
        cosmetics: cosmetics
    }));
}

// WebSocket handler: Send friends list
function sendFriendsList(ws) {
    if (!isClientReady || !fnClient || !fnClient.friends) {
        ws.send(JSON.stringify({
            type: 'friends',
            friends: []
        }));
        return;
    }
    
    const friends = Array.from(fnClient.friends.values()).map(friend => ({
        id: friend.id,
        displayName: friend.displayName,
        isOnline: friend.presence?.isOnline || false
    }));
    
    ws.send(JSON.stringify({
        type: 'friends',
        friends
    }));
}

// WebSocket handler: Broadcast friends list to all clients
function broadcastFriendsList() {
    if (!isClientReady || !fnClient || !fnClient.friends) return;
    
    const friends = Array.from(fnClient.friends.values()).map(friend => ({
        id: friend.id,
        displayName: friend.displayName,
        isOnline: friend.presence?.isOnline || false
    }));
    
    broadcastToWebClients({
        type: 'friends',
        friends
    });
}

// WebSocket handler: Set cosmetic
async function handleSetCosmetic(ws, data) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        const { id, type } = data;
        
        if (!id || !type) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Missing cosmetic ID or type',
                messageType: 'error'
            }));
            return;
        }
        
        // Find the cosmetic in the database
        let cosmetic = await getDbCosmetic(id);
        
        // If cosmetic not found in database but user wants to apply it, add a simple entry
        if (!cosmetic) {
            // Store a basic entry for this unknown cosmetic
            await insertDbCosmetic(
                id,
                id, // Use ID as name for unknown cosmetics
                type, // Use provided type
                'common', // Use common as default rarity
                'https://i.imgur.com/BJZCnJF.png' // Default icon
            );
            
            cosmetic = {
                id: id,
                name: id,
                type: type,
                rarity: 'common',
                icon: 'https://i.imgur.com/BJZCnJF.png'
            };
            
            logger.info(`Created database entry for unknown cosmetic: ${id}`);
        }
        
        // Apply the cosmetic based on type
        switch (type) {
            case 'outfit':
                await fnClient.party.me.setOutfit(id);
                break;
                
            case 'backpack':
                await fnClient.party.me.setBackpack(id);
                break;
                
            case 'emote':
                await fnClient.party.me.setEmote(id);
                break;
                
            case 'pickaxe':
                await fnClient.party.me.setPickaxe(id);
                break;
                
            default:
                // Try to handle unknown types gracefully
                try {
                    if (fnClient.party.me[`set${type.charAt(0).toUpperCase() + type.slice(1)}`]) {
                        await fnClient.party.me[`set${type.charAt(0).toUpperCase() + type.slice(1)}`](id);
                    } else {
                        ws.send(JSON.stringify({
                            type: 'notification',
                            message: `Unsupported cosmetic type: ${type}, but attempting to apply`,
                            messageType: 'warning'
                        }));
                        // Fallback to setOutfit
                        await fnClient.party.me.setOutfit(id);
                    }
                } catch (err) {
                    ws.send(JSON.stringify({
                        type: 'notification',
                        message: `Unsupported cosmetic type: ${type}`,
                        messageType: 'error'
                    }));
                    return;
                }
        }
        
        logger.success(`Changed ${type} to ${cosmetic.name} (${id})`);
        
        // Notify all clients about the change
        broadcastToWebClients({
            type: 'cosmeticChanged',
            cosmetic: {
                id,
                name: cosmetic.name,
                type
            }
        });
    } catch (error) {
        logger.error(`Failed to set cosmetic: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to set cosmetic: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Stop emote
async function handleStopEmote(ws) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        await fnClient.party.me.clearEmote();
        logger.success('Stopped current emote');
        
        // Notify all clients
        broadcastToWebClients({
            type: 'emoteStop',
            message: 'Emote stopped'
        });
    } catch (error) {
        logger.error(`Failed to stop emote: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to set cosmetic: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Set level
async function handleSetLevel(ws, data) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        const { level } = data;
        
        if (!level || isNaN(level) || level < 1) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Invalid level (minimum 1)',
                messageType: 'error'
            }));
            return;
        }
        
        await fnClient.party.me.setLevel(level);
        logger.success(`Set level to ${level}`);
        
        // Notify all clients about the change
        broadcastToWebClients({
            type: 'levelChanged',
            level
        });
    } catch (error) {
        logger.error(`Failed to set level: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to set level: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Refresh cosmetics
async function handleRefreshCosmetics(ws) {
    try {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Refreshing cosmetics database...',
            messageType: 'info'
        }));
        
        await fetchAndUpdateCosmetics();
        
        // Send updated cosmetics to all clients
        broadcastToWebClients({
            type: 'cosmetics',
            cosmetics
        });
        
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Cosmetics database refreshed successfully',
            messageType: 'success'
        }));
    } catch (error) {
        logger.error(`Failed to refresh cosmetics: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to refresh cosmetics: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Accept all friend requests
async function handleAcceptAllFriends(ws) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        const pendingFriends = fnClient.pendingFriends;
        let acceptedCount = 0;
        
        if (pendingFriends.size === 0) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'No pending friend requests',
                messageType: 'info'
            }));
            return;
        }
        
        for (const [, friend] of pendingFriends) {
            if (friend.direction === 'INBOUND') {
                await friend.accept();
                acceptedCount++;
            }
        }
        
        logger.success(`Accepted ${acceptedCount} friend requests`);
        
        // Update friends list for all clients
        broadcastFriendsList();
        
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Accepted ${acceptedCount} friend requests`,
            messageType: 'success'
        }));
    } catch (error) {
        logger.error(`Failed to accept all friend requests: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to accept all friend requests: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Reboot bot
async function handleRebootBot(ws) {
    ws.send(JSON.stringify({
        type: 'notification',
        message: 'Rebooting bot...',
        messageType: 'info'
    }));
    
    logger.warn('Rebooting bot by user request');
    
    // Notify all clients
    broadcastToWebClients({
        type: 'notification',
        message: 'Bot is rebooting, please wait...',
        messageType: 'info'
    });
    
    try {
        // Logout if connected
        if (isClientReady && fnClient) {
            await fnClient.logout();
            logger.info('Logged out successfully');
        }
        
        // Reset state
        isClientReady = false;
        fnClient = null;
        
        // Reinitialize client with fresh auth
        const auth = await createAuthInputHandler();
        fnClient = await initializeFortniteClient(auth);
        
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot rebooted successfully',
            messageType: 'success'
        }));
    } catch (error) {
        logger.error(`Failed to reboot bot: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to reboot bot: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Invite friend to party
async function handleInviteFriend(ws, data) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        const { friendId } = data;
        
        if (!friendId) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Missing friend ID',
                messageType: 'error'
            }));
            return;
        }
        
        const friend = fnClient.friends.get(friendId);
        
        if (!friend) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Friend not found',
                messageType: 'error'
            }));
            return;
        }
        
        await friend.invite();
        logger.success(`Invited ${friend.displayName} to the party`);
        
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Invited ${friend.displayName} to the party`,
            messageType: 'success'
        }));
    } catch (error) {
        logger.error(`Failed to invite friend: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to invite friend: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Remove friend
async function handleRemoveFriend(ws, data) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        const { friendId } = data;
        
        if (!friendId) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Missing friend ID',
                messageType: 'error'
            }));
            return;
        }
        
        const friend = fnClient.friends.get(friendId);
        
        if (!friend) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Friend not found',
                messageType: 'error'
            }));
            return;
        }
        
        await friend.remove();
        logger.success(`Removed ${friend.displayName} from friends list`);
        
        // Update friends list for all clients
        broadcastFriendsList();
        
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Removed ${friend.displayName} from friends list`,
            messageType: 'success'
        }));
    } catch (error) {
        logger.error(`Failed to remove friend: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to remove friend: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Send message to friend
async function handleSendMessage(ws, data) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        const { recipientId, content } = data;
        
        if (!recipientId || !content) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Missing recipient ID or message content',
                messageType: 'error'
            }));
            return;
        }
        
        const friend = fnClient.friends.get(recipientId);
        
        if (!friend) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Friend not found',
                messageType: 'error'
            }));
            return;
        }
        
        await friend.sendMessage(content);
        logger.info(`Sent message to ${friend.displayName}: ${content}`);
        
        // No need to send notification for successful message send
    } catch (error) {
        logger.error(`Failed to send message: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to send message: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Change bot account
async function handleChangeAccount(ws) {
    ws.send(JSON.stringify({
        type: 'notification',
        message: 'Changing account, please check console for input...',
        messageType: 'info'
    }));
    
    logger.warn('Changing bot account by user request');
    
    // Notify all clients
    broadcastToWebClients({
        type: 'notification',
        message: 'Bot is changing account, please enter credentials in console...',
        messageType: 'info'
    });
    
    try {
        // Logout if connected
        if (isClientReady && fnClient) {
            await fnClient.logout();
            logger.info('Logged out successfully');
        }
        
        // Reset state
        isClientReady = false;
        fnClient = null;
        
        // Remove old auth file to force new login
        if (fs.existsSync(config.deviceAuthFile)) {
            fs.unlinkSync(config.deviceAuthFile);
            logger.info('Removed device auth file for new login');
        }
        
        // Get fresh auth
        const auth = await createAuthInputHandler();
        
        // Reinitialize client with fresh auth
        fnClient = await initializeFortniteClient(auth);
        
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Account changed successfully',
            messageType: 'success'
        }));
    } catch (error) {
        logger.error(`Failed to change account: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to change account: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// Add new handler for setting bot status
async function handleSetStatus(ws, data) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        const { status } = data;
        
        if (!status) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Missing status message',
                messageType: 'error'
            }));
            return;
        }
        
        await fnClient.setStatus(status);
        logger.success(`Set status to: ${status}`);
        
        // Notify all clients about the change
        broadcastToWebClients({
            type: 'statusChanged',
            status: status
        });
        
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Status updated successfully',
            messageType: 'success'
        }));
    } catch (error) {
        logger.error(`Failed to set status: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to set status: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Check cosmetic variants
async function handleCheckCosmeticVariants(ws, data) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        const { id, name } = data;
        
        if (!id) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Missing cosmetic ID',
                messageType: 'error'
            }));
            return;
        }
        
        logger.info(`Checking variants for cosmetic ${name} (${id})`);
        
        // First check if we have variants cached in our database
        const cachedVariants = await getVariantsFromDatabase(id);
        
        if (cachedVariants && cachedVariants.length > 0) {
            logger.info(`Using cached variants for ${name} (${cachedVariants.length} variants found)`);
            
            // Send variant data to client
            ws.send(JSON.stringify({
                type: 'variantsData',
                outfitName: name,
                variants: cachedVariants
            }));
            
            return;
        }
        
        // Get variant data from Fortnite API if not cached
        try {
            const response = await axios.get(`https://fortnite-api.com/v2/cosmetics/br/${id}`, {
                headers: {
                    'Authorization': config.fortniteApiKey
                }
            });
            
            if (response.data && response.data.data) {
                const cosmeticData = response.data.data;
                const variants = [];
                
                // Check if the cosmetic has variants
                if (cosmeticData.variants && cosmeticData.variants.length > 0) {
                    // Process each variant channel
                    for (const channel of cosmeticData.variants) {
                        for (const option of channel.options) {
                            const variantData = {
                                channel: channel.channel,
                                tag: option.tag,
                                name: option.name,
                                image: option.image || null
                            };
                            
                            variants.push(variantData);
                            
                            // Store variant in database for future use
                            await storeVariantInDatabase(id, variantData);
                        }
                    }
                }
                
                // Send variant data to client
                ws.send(JSON.stringify({
                    type: 'variantsData',
                    outfitName: name,
                    variants: variants
                }));
                
                logger.info(`Found ${variants.length} variants for ${name} and stored in database`);
            } else {
                // No variant data available
                ws.send(JSON.stringify({
                    type: 'variantsData',
                    outfitName: name,
                    variants: []
                }));
                
                logger.info(`No variant data found for ${name}`);
            }
        } catch (error) {
            // API error, still allow applying the cosmetic
            logger.error(`Failed to get variant data from API: ${error.message}`);
            
            ws.send(JSON.stringify({
                type: 'variantsData',
                outfitName: name,
                variants: []
            }));
        }
    } catch (error) {
        logger.error(`Failed to check cosmetic variants: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to check variants: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// WebSocket handler: Set outfit with variants
async function handleSetOutfitWithVariants(ws, data) {
    if (!isClientReady || !fnClient) {
        ws.send(JSON.stringify({
            type: 'notification',
            message: 'Bot is not connected',
            messageType: 'error'
        }));
        return;
    }
    
    try {
        const { outfitId, variants } = data;
        
        if (!outfitId) {
            ws.send(JSON.stringify({
                type: 'notification',
                message: 'Missing outfit ID',
                messageType: 'error'
            }));
            return;
        }
        
        // Find the cosmetic in the database
        let cosmetic = await getDbCosmetic(outfitId);
        
        // If cosmetic not found in database but user wants to apply it, add a simple entry
        if (!cosmetic) {
            // Store a basic entry for this unknown cosmetic
            await insertDbCosmetic(
                outfitId,
                outfitId, // Use ID as name for unknown cosmetics
                'outfit', // Assume it's an outfit
                'common', // Use common as default rarity
                'https://i.imgur.com/BJZCnJF.png' // Default icon
            );
            
            cosmetic = {
                id: outfitId,
                name: outfitId,
                type: 'outfit',
                rarity: 'common',
                icon: 'https://i.imgur.com/BJZCnJF.png'
            };
            
            logger.info(`Created database entry for unknown cosmetic: ${outfitId}`);
        }
        
        // Format variants for fnbr.js library
        const formattedVariants = {};
        
        if (variants && Array.isArray(variants) && variants.length > 0) {
            for (const variant of variants) {
                if (variant.channel && variant.variant) {
                    formattedVariants[variant.channel] = variant.variant;
                }
            }
            
            logger.debug(`Applying outfit with variants: ${JSON.stringify(formattedVariants)}`);
            
            // Apply outfit with variants
            await fnClient.party.me.setOutfit(outfitId, { styles: formattedVariants });
            logger.success(`Changed outfit to ${cosmetic.name} (${outfitId}) with ${Object.keys(formattedVariants).length} custom variants`);
        } else {
            // Apply outfit without variants
            await fnClient.party.me.setOutfit(outfitId);
            logger.success(`Changed outfit to ${cosmetic.name} (${outfitId}) without variants`);
        }
        
        // Notify all clients about the change
        broadcastToWebClients({
            type: 'cosmeticChanged',
            cosmetic: {
                id: outfitId,
                name: cosmetic.name,
                type: 'outfit'
            }
        });
        
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Changed outfit to ${cosmetic.name}${Object.keys(formattedVariants).length > 0 ? ' with custom variants' : ''}`,
            messageType: 'success'
        }));
    } catch (error) {
        logger.error(`Failed to set outfit with variants: ${error.message}`);
        ws.send(JSON.stringify({
            type: 'notification',
            message: `Failed to set outfit: ${error.message}`,
            messageType: 'error'
        }));
    }
}

// Database helper: Store variant in database
function storeVariantInDatabase(cosmeticId, variant) {
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT OR IGNORE INTO cosmetic_variants (cosmetic_id, channel, tag, name, image) VALUES (?, ?, ?, ?, ?)',
            [cosmeticId, variant.channel, variant.tag, variant.name, variant.image],
            function(err) {
                if (err) {
                    logger.error(`Failed to store variant in database: ${err.message}`);
                    reject(err);
                } else {
                    resolve(this.lastID);
                }
            }
        );
    });
}

// Database helper: Get variants from database
function getVariantsFromDatabase(cosmeticId) {
    return new Promise((resolve, reject) => {
        db.all(
            'SELECT channel, tag, name, image FROM cosmetic_variants WHERE cosmetic_id = ?',
            [cosmeticId],
            (err, rows) => {
                if (err) {
                    logger.error(`Failed to get variants from database: ${err.message}`);
                    reject(err);
                } else {
                    resolve(rows);
                }
            }
        );
    });
}

// Load initial data when connected
function loadInitialData() {
    sendSocketMessage('getBotInfo');
    sendSocketMessage('getCosmetics');
    sendSocketMessage('getFriends');
}

// Broadcast message to all connected web clients
function broadcastToWebClients(message) {
    const messageStr = JSON.stringify(message);
    
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
        }
    });
}

// Initialize Express app
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Setup Express routes
function setupExpressRoutes() {
    // Serve the HTML page directly
    app.get('/', (req, res) => {
        fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, data) => {
            if (err) {
                logger.error(`Failed to read index.html: ${err.message}`);
                res.status(500).send('Error loading page');
                return;
            }
            
            res.send(data);
        });
    });
    
    // API routes
    app.get('/api/cosmetics', (req, res) => {
        res.json(cosmetics);
    });
    
    app.get('/api/bot/info', (req, res) => {
        if (!isClientReady || !fnClient) {
            res.json({
                displayName: 'Not connected',
                level: 'N/A',
                friendCount: 0,
                status: 'Offline'
            });
            return;
        }
        
        res.json({
            displayName: fnClient.user?.displayName || 'Unknown',
            level: fnClient.party?.me?.level || config.defaultCosmetics.level,
            friendCount: fnClient.friends?.size || 0,
            status: 'Online'
        });
    });
}

// Add a new feature to support rotating status messages
function setupStatusRotation() {
    if (!isClientReady || !fnClient) return;
    
    const statusMessages = [
        'SaphyreFN - The Best Fortnite Bot',
        'Add me to play together!',
        'SaphyreFN - Custom Cosmetics',
        'SaphyreFN - Ready to join!',
        'SaphyreFN - Join my party!'
    ];
    
    let currentIndex = 0;
    
    // Rotate status every 5 minutes
    setInterval(async () => {
        try {
            currentIndex = (currentIndex + 1) % statusMessages.length;
            await fnClient.setStatus(statusMessages[currentIndex]);
            logger.info(`Changed status to: ${statusMessages[currentIndex]}`);
        } catch (error) {
            logger.error(`Failed to update status: ${error.message}`);
        }
    }, 5 * 60 * 1000);
}

// Main initialization function
async function initialize() {
    try {
        // ASCII Art Logo
        console.log('\n');
        console.log(colors.cyan('   _____              _                    _______ _   _ '));
        console.log(colors.cyan('  / ____|            | |                  |  ____| \\ | |'));
        console.log(colors.cyan(' | (___   __ _ _ __  | |__  _   _ _ __ __|  |__  |  \\| |'));
        console.log(colors.cyan('  \\___ \\ / _` | \'_ \\ | \'_ \\| | | | \'__/ _ \\  __| | . ` |'));
        console.log(colors.cyan('  ____) | (_| | |_) || |_| | |_| | | |  __/ |    | |\\  |'));
        console.log(colors.cyan(' |_____/ \\__,_| .!/_|_| |_|\\__,_|_|  \\___|_|    |_| \\_|'));
        console.log(colors.cyan('               | |           __/ |                      '));
        console.log(colors.cyan('               |_|          |___/                       '));
        console.log('\n');
        
        logger.info('Starting SaphyreFN...');
        
        // Initialize database
        await initializeDatabase();
        
        // Setup Express routes
        setupExpressRoutes();
        
        // Find an available port and start HTTP server
        let currentPort = config.httpPort;
        let serverStarted = false;
        let portAttempts = 0;
        const maxPortAttempts = 10;

        while (!serverStarted && portAttempts < maxPortAttempts) {
            try {
                await new Promise((resolve, reject) => {
                    server.listen(currentPort, () => {
                        const localIp = ip.address();
                        logger.success(`Web server started on http://${localIp}:${currentPort}`);
                        logger.info(`Getting public IP address for external access...`);
                        
                        // Get public IP for better information - this is critical to fix user's issue
                        axios.get('https://api.ipify.org?format=json')
                            .then(response => {
                                if (response.data && response.data.ip) {
                                    const publicIp = response.data.ip;
                                    logger.success(`For external access, use: http://${publicIp}:${currentPort}`);
                                    logger.info(`Make sure your router forwards port ${currentPort} to this machine (${localIp})`);
                                } else {
                                    logger.warn('Could not fetch public IP address');
                                }
                            })
                            .catch(error => {
                                logger.warn('Could not fetch public IP address: ' + error.message);
                            });

                        serverStarted = true;
                        resolve();
                    });
                    
                    server.on('error', (error) => {
                        if (error.code === 'EADDRINUSE') {
                            logger.warn(`Port ${currentPort} is already in use`);
                            server.close();
                            currentPort++;
                            portAttempts++;
                            resolve(); // Resolve so we can try the next port
                        } else {
                            reject(error);
                        }
                    });
                });
            } catch (error) {
                if (portAttempts >= maxPortAttempts) {
                    throw new Error(`Failed to find an available port after ${maxPortAttempts} attempts`);
                }
            }
            
            if (serverStarted) break;
        }
        
        if (!serverStarted) {
            throw new Error(`Failed to start server: Could not find an available port`);
        }
        
        // Setup WebSocket server
        wss.on('connection', (ws) => {
            connectedClients.add(ws);
            logger.info(`New WebSocket client connected (${connectedClients.size} total)`);
            
            ws.on('message', (message) => {
                handleWebSocketMessage(ws, message);
            });
            
            ws.on('close', () => {
                connectedClients.delete(ws);
                logger.info(`WebSocket client disconnected (${connectedClients.size} remaining)`);
            });
        });
        
        try {
            // Get authentication details
            const auth = await createAuthInputHandler();
            logger.debug('Authentication obtained, proceeding to initialize Fortnite client');
            
            // Initialize Fortnite client
            await initializeFortniteClient(auth);
            
            // Fetch and update cosmetics
            await fetchAndUpdateCosmetics();
            
            logger.success('SaphyreFN initialization complete!');
        } catch (error) {
            logger.error(`Fortnite client initialization failed: ${error.message}`);
            logger.debug(`Initialization error stack: ${error.stack}`);
            // Still continue running the web server even if Fortnite client fails
            logger.info('Web server is still running. You can restart the Fortnite client from the web interface.');
        }
    } catch (error) {
        logger.error(`Initialization failed: ${error.message}`);
        logger.debug(`Server initialization error stack: ${error.stack}`);
        process.exit(1);
    }
}

// Start the server
initialize();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    
    try {
        if (fnClient) {
            await fnClient.logout();
            logger.success('Logged out from Fortnite');
        }
        
        if (db) {
            db.close();
            logger.success('Database connection closed');
        }
        
        server.close(() => {
            logger.success('HTTP server closed');
            process.exit(0);
        });
    } catch (error) {
        logger.error(`Error during shutdown: ${error.message}`);
        process.exit(1);
    }
});