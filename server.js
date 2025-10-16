const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '')));

const gameState = {
    players: {},
    rooms: {}
};

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('player_online', (playerName) => {
        gameState.players[socket.id] = { name: playerName };
        io.emit('update_online_players', Object.values(gameState.players).map(p => p.name));
    });

    socket.on('get_rooms', () => {
        socket.emit('update_room_list', Object.values(gameState.rooms));
    });
    
    socket.on('create_room', (roomData) => {
        const roomId = `room_${socket.id}`;
        gameState.rooms[roomId] = { ...roomData, id: roomId, hostSocket: socket.id };
        
        // [FIX #1] ให้ Host เข้าร่วม "ห้อง" ของตัวเองทันทีที่สร้าง
        socket.join(roomId); 
        
        io.emit('update_room_list', Object.values(gameState.rooms));
        socket.emit('joined_room', gameState.rooms[roomId]); // ส่งข้อมูลห้องกลับไปให้ Host
    });
    
    socket.on('join_room', ({ roomId, playerName }) => {
        const room = gameState.rooms[roomId];
        if (room && !room.challenger) {
            room.challenger = playerName;
            room.challengerSocket = socket.id;
            
            // [FIX #2] ให้ Challenger เข้าร่วม "ห้อง" ด้วย
            socket.join(roomId);
            
            // [FIX #3] แจ้งทุกคนในห้องว่ามีคนเข้ามา (รวมถึง Host)
            io.to(roomId).emit('player_joined', room);
            
            io.emit('update_room_list', Object.values(gameState.rooms));
        }
    });

    socket.on('player_ready', (roomId) => {
        const room = gameState.rooms[roomId];
        if (room) {
            room.challengerReady = true;
            // แจ้ง Host ว่าอีกฝ่ายพร้อมแล้ว
            io.to(room.hostSocket).emit('opponent_ready', room);
        }
    });

    socket.on('start_game', (roomId) => {
        const room = gameState.rooms[roomId];
        if (room && room.challengerReady) {
            room.gameStarted = true;
            room.gameState = createInitialGameState(room.host, room.challenger);
            
            // [FIX #4] ส่งสัญญาณเริ่มเกมไปให้ "ทุกคนในห้อง" พร้อมกัน
            io.to(roomId).emit('game_started', room);
            
            io.emit('update_room_list', Object.values(gameState.rooms));
        }
    });
    
    socket.on('make_move', ({ roomId, r, c }) => {
        const room = gameState.rooms[roomId];
        if (room && room.gameState) {
            const playerColor = room.gameState.playerNames['1'] === gameState.players[socket.id].name ? 1 : 2;
            
            // ตรวจสอบว่าเป็นตาของผู้เล่นคนนั้นจริงๆ
            if (room.gameState.currentPlayer === playerColor) {
                const moveSuccess = handleMoveServer(room.gameState, r, c);
                if (moveSuccess) {
                    // [FIX #5] ส่งสถานะเกมที่อัปเดตแล้วไปให้ "ทุกคนในห้อง"
                    io.to(roomId).emit('update_game_state', room.gameState);
                }
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // ... (ส่วนจัดการผู้เล่นออกจากเกม ยังคงเหมือนเดิม) ...
        const player = gameState.players[socket.id];
        if (player) {
            delete gameState.players[socket.id];
            io.emit('update_online_players', Object.values(gameState.players).map(p => p.name));
        }
    });
});

// --- Server-Side Game Logic (No changes needed here) ---
function createInitialGameState(hostName, challengerName) {
    let board = Array(15).fill(0).map(() => Array(15).fill(0));
    const center = Math.floor(15 / 2);
    board[center - 1][center] = 1; board[center + 1][center] = 1;
    board[center][center - 1] = 2; board[center][center + 1] = 2;
    return {
        boardState: board, currentPlayer: 1, capturedStones: { '1': 0, '2': 0 },
        moveCounts: { '1': 100, '2': 100 }, passes: 0, koPoint: null,
        playerNames: { '1': challengerName, '2': hostName }
    };
}

function handleMoveServer(gameState, r, c) {
    if (gameState.boardState[r][c] !== 0) return false;
    
    // This is a simplified version. A real implementation would have capture logic.
    gameState.boardState[r][c] = gameState.currentPlayer;
    gameState.moveCounts[gameState.currentPlayer]--;
    gameState.currentPlayer = gameState.currentPlayer === 1 ? 2 : 1;
    return true; // Move was successful
}

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
