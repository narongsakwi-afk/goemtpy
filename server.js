const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Serve the index.html file
app.use(express.static(path.join(__dirname, '')));

// This will store all our game data instead of localStorage
const gameState = {
    players: {}, // Tracks online players
    rooms: {}    // Tracks all room and game data
};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- Player Management ---
    socket.on('player_online', (playerName) => {
        gameState.players[socket.id] = playerName;
        socket.broadcast.emit('update_online_players', Object.values(gameState.players));
        socket.emit('update_online_players', Object.values(gameState.players));
        console.log('Online players:', Object.values(gameState.players));
    });

    // --- Room Management ---
    socket.on('get_rooms', () => {
        socket.emit('update_room_list', Object.values(gameState.rooms));
    });
    
    socket.on('create_room', (roomData) => {
        const roomId = `room_${socket.id}`;
        gameState.rooms[roomId] = { ...roomData, id: roomId, hostSocket: socket.id, players: {[socket.id]: roomData.host} };
        io.emit('update_room_list', Object.values(gameState.rooms));
    });
    
    socket.on('join_room', ({ roomId, playerName }) => {
        const room = gameState.rooms[roomId];
        if (room && !room.challenger) {
            room.challenger = playerName;
            room.challengerSocket = socket.id;
            room.players[socket.id] = playerName;
            socket.join(roomId);
            io.to(room.hostSocket).emit('player_joined', room); // Notify host
            socket.emit('joined_room', room); // Confirm join to challenger
            io.emit('update_room_list', Object.values(gameState.rooms));
        }
    });

    socket.on('player_ready', (roomId) => {
        const room = gameState.rooms[roomId];
        if (room) {
            room.challengerReady = true;
            io.to(room.hostSocket).emit('opponent_ready', room);
        }
    });

    // --- Game Logic ---
    socket.on('start_game', (roomId) => {
        const room = gameState.rooms[roomId];
        if (room && room.challengerReady) {
            room.gameStarted = true;
            room.gameState = createInitialGameState(room.host, room.challenger);
            io.to(roomId).emit('game_started', room); // Tell both players in room to start
            io.to(room.hostSocket).emit('game_started', room); // Also host
            io.emit('update_room_list', Object.values(gameState.rooms));
        }
    });
    
    socket.on('make_move', ({ roomId, r, c }) => {
        const room = gameState.rooms[roomId];
        if (room && room.gameState) {
            // Server-side validation and move handling will go here
            // For now, we just update and broadcast
            handleMoveServer(room.gameState, r, c, socket.id, room.players);
            io.to(room.hostSocket).emit('update_game_state', room.gameState);
            io.to(room.challengerSocket).emit('update_game_state', room.gameState);
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        delete gameState.players[socket.id];
        // Handle player leaving a room or game
        // ... (more logic needed for robustness)
        io.emit('update_online_players', Object.values(gameState.players));
    });
});


// Helper functions (could be in another file)
function createInitialGameState(hostName, challengerName) {
    let board = Array(15).fill(0).map(() => Array(15).fill(0));
    const center = Math.floor(15 / 2);
    board[center - 1][center] = 1; board[center + 1][center] = 1;
    board[center][center - 1] = 2; board[center][center + 1] = 2;
    return {
        boardState: board, currentPlayer: 1, // Black starts
        capturedStones: { '1': 0, '2': 0 }, moveCounts: { '1': 100, '2': 100 },
        passes: 0, koPoint: null,
        playerNames: { '1': challengerName, '2': hostName }
    };
}

function handleMoveServer(gameState, r, c, socketId, players) {
    // A simplified version. Real version needs full validation.
    const playerColor = gameState.playerNames['1'] === players[socketId] ? 1 : 2;
    if (gameState.currentPlayer !== playerColor) return; // Not their turn
    if (gameState.boardState[r][c] !== 0) return; // Already a stone there

    gameState.boardState[r][c] = playerColor;
    gameState.moveCounts[playerColor]--;
    // Switch player
    gameState.currentPlayer = playerColor === 1 ? 2 : 1;
}


server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});