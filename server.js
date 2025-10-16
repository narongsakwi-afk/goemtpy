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
    const { players, rooms } = gameState;

    socket.on('player_online', (playerName) => {
        players[socket.id] = { name: playerName, currentRoom: null };
        io.emit('update_online_players', Object.values(players).map(p => p.name));
    });

    socket.on('get_rooms', () => {
        socket.emit('update_room_list', Object.values(rooms));
    });
    
    socket.on('create_room', (roomData) => {
        const roomId = `room_${socket.id}`;
        rooms[roomId] = { ...roomData, id: roomId, hostSocket: socket.id };
        players[socket.id].currentRoom = roomId;
        socket.join(roomId); 
        io.emit('update_room_list', Object.values(rooms));
        socket.emit('joined_room', rooms[roomId]);
    });
    
    socket.on('join_room', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (room && !room.challenger) {
            room.challenger = playerName;
            room.challengerSocket = socket.id;
            players[socket.id].currentRoom = roomId;
            socket.join(roomId);
            io.to(roomId).emit('player_joined', room);
            io.emit('update_room_list', Object.values(rooms));
        }
    });

    socket.on('player_ready', (roomId) => {
        const room = rooms[roomId];
        if (room) {
            room.challengerReady = true;
            io.to(room.hostSocket).emit('opponent_ready', room);
        }
    });

    socket.on('start_game', (roomId) => {
        const room = rooms[roomId];
        if (room && room.challengerReady) {
            room.gameStarted = true;
            room.gameState = createInitialGameState(room.host, room.challenger);
            io.to(roomId).emit('game_started', room);
            io.emit('update_room_list', Object.values(rooms));
        }
    });
    
    socket.on('make_move', ({ roomId, r, c }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState) return;
        
        const playerColor = room.gameState.playerNames['1'] === players[socket.id].name ? 1 : 2;
        if (room.gameState.currentPlayer !== playerColor) return; // Not your turn

        const moveResult = handleMoveServer(room.gameState, r, c);
        if (moveResult.success) {
            // Rule 3: Check for all stones captured
            const counts = countStonesOnBoard(room.gameState.boardState);
            const opponentColor = playerColor === 1 ? 2 : 1;
            if (counts[opponentColor] === 0) {
                const winnerName = room.gameState.playerNames[playerColor];
                io.to(roomId).emit('game_over', { winner: winnerName, reason: `จับหมากของฝ่ายตรงข้ามได้ทั้งหมด` });
                delete rooms[roomId]; // Clean up room
                return;
            }

            // Rule 1: Check if move limit is reached
            if (room.gameState.moveCounts[1] === 0 || room.gameState.moveCounts[2] === 0) {
                const finalCounts = countStonesOnBoard(room.gameState.boardState);
                let winnerName = '';
                let reason = '';
                if (finalCounts[1] > finalCounts[2]) {
                    winnerName = room.gameState.playerNames[1];
                    reason = `มีหมากบนกระดานมากกว่า (${finalCounts[1]} ต่อ ${finalCounts[2]})`;
                } else if (finalCounts[2] > finalCounts[1]) {
                    winnerName = room.gameState.playerNames[2];
                    reason = `มีหมากบนกระดานมากกว่า (${finalCounts[2]} ต่อ ${finalCounts[1]})`;
                } else {
                    winnerName = 'เสมอ';
                    reason = `มีหมากบนกระดานเท่ากัน`;
                }
                io.to(roomId).emit('game_over', { winner: winnerName, reason: reason });
                delete rooms[roomId]; // Clean up room
                return;
            }
            
            io.to(roomId).emit('update_game_state', room.gameState);
        }
    });

    // Rule 2: Pass move
    socket.on('pass_move', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.gameState) return;

        const playerColor = room.gameState.playerNames['1'] === players[socket.id].name ? 1 : 2;
        if (room.gameState.currentPlayer !== playerColor) return;

        room.gameState.passCounts[playerColor]++;
        if (room.gameState.passCounts[playerColor] >= 5) {
            const winnerName = room.gameState.playerNames[playerColor === 1 ? 2 : 1];
            io.to(roomId).emit('game_over', { winner: winnerName, reason: `ฝ่ายตรงข้ามผ่านครบ 5 ครั้ง` });
            delete rooms[roomId];
            return;
        }
        room.gameState.currentPlayer = playerColor === 1 ? 2 : 1; // Switch player
        io.to(roomId).emit('update_game_state', room.gameState);
    });

    // Rule 4: Surrender
    socket.on('surrender', (roomId) => {
        const room = rooms[roomId];
        if (!room || !room.gameState) return;
        const playerColor = room.gameState.playerNames['1'] === players[socket.id].name ? 1 : 2;
        const winnerName = room.gameState.playerNames[playerColor === 1 ? 2 : 1];
        io.to(roomId).emit('game_over', { winner: winnerName, reason: `ฝ่ายตรงข้ามยอมแพ้` });
        delete rooms[roomId];
    });

    socket.on('disconnect', () => {
        const player = players[socket.id];
        if (player) {
            console.log(`Player ${player.name} disconnected: ${socket.id}`);
            
            // Rule 5: Opponent disconnects
            const roomId = player.currentRoom;
            if (roomId && rooms[roomId] && rooms[roomId].gameStarted) {
                const room = rooms[roomId];
                const isHost = room.hostSocket === socket.id;
                const remainingPlayerSocket = isHost ? room.challengerSocket : room.hostSocket;
                const winnerName = isHost ? room.challenger : room.host;
                
                if (remainingPlayerSocket) {
                    io.to(remainingPlayerSocket).emit('game_over', { winner: winnerName, reason: 'ฝ่ายตรงข้ามออกจากเกม' });
                }
                delete rooms[roomId];
            }
            
            delete players[socket.id];
            io.emit('update_online_players', Object.values(players).map(p => p.name));
            io.emit('update_room_list', Object.values(rooms));
        }
    });
});

// --- Server-Side Helper Functions ---
function createInitialGameState(hostName, challengerName) {
    let board = Array(15).fill(0).map(() => Array(15).fill(0));
    const center = Math.floor(15 / 2);
    board[center - 1][center] = 1; board[center + 1][center] = 1;
    board[center][center - 1] = 2; board[center][center + 1] = 2;
    return {
        boardState: board, currentPlayer: 1, capturedStones: { '1': 0, '2': 0 },
        moveCounts: { '1': 100, '2': 100 }, passes: 0, koPoint: null,
        passCounts: { '1': 0, '2': 0 }, // For rule 2
        playerNames: { '1': challengerName, '2': hostName }
    };
}

function handleMoveServer(gameState, r, c) {
    if (gameState.boardState[r][c] !== 0) return { success: false };
    
    // Simplified move logic, doesn't include capture yet for brevity
    gameState.boardState[r][c] = gameState.currentPlayer;
    gameState.moveCounts[gameState.currentPlayer]--;
    gameState.currentPlayer = gameState.currentPlayer === 1 ? 2 : 1;
    return { success: true };
}

function countStonesOnBoard(boardState) {
    const counts = { 1: 0, 2: 0 };
    for (let r = 0; r < 15; r++) {
        for (let c = 0; c < 15; c++) {
            if (boardState[r][c] === 1) counts[1]++;
            else if (boardState[r][c] === 2) counts[2]++;
        }
    }
    return counts;
}

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
