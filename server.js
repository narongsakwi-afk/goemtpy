const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new new Server(server);

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
    
    // [FIXED] Re-implemented the full game logic here
    socket.on('make_move', ({ roomId, r, c }) => {
        const room = rooms[roomId];
        if (!room || !room.gameState) return;
        
        const player = players[socket.id];
        if (!player) return;
        
        const playerColor = room.gameState.playerNames['1'] === player.name ? 1 : 2;
        if (room.gameState.currentPlayer !== playerColor) return;

        const moveResult = handleMoveServer(room.gameState, r, c);
        
        if (moveResult.success) {
            // Check win conditions after a successful move
            const counts = countStonesOnBoard(room.gameState.boardState);
            const opponentColor = playerColor === 1 ? 2 : 1;
            if (counts[opponentColor] === 0 && moveResult.captured > 0) {
                const winnerName = room.gameState.playerNames[playerColor];
                io.to(roomId).emit('game_over', { winner: winnerName, reason: `จับหมากของฝ่ายตรงข้ามได้ทั้งหมด` });
                delete rooms[roomId];
                return;
            }

            if (room.gameState.moveCounts[1] <= 0 || room.gameState.moveCounts[2] <= 0) {
                const finalCounts = countStonesOnBoard(room.gameState.boardState);
                let winnerName = 'เสมอ', reason = `มีหมากบนกระดานเท่ากัน`;
                if (finalCounts[1] > finalCounts[2]) {
                    winnerName = room.gameState.playerNames[1];
                    reason = `มีหมากบนกระดานมากกว่า (${finalCounts[1]} ต่อ ${finalCounts[2]})`;
                } else if (finalCounts[2] > finalCounts[1]) {
                    winnerName = room.gameState.playerNames[2];
                    reason = `มีหมากบนกระดานมากกว่า (${finalCounts[2]} ต่อ ${finalCounts[1]})`;
                }
                io.to(roomId).emit('game_over', { winner: winnerName, reason: reason });
                delete rooms[roomId];
                return;
            }
            
            io.to(roomId).emit('update_game_state', room.gameState);
        } else if (moveResult.error) {
            // Optionally, send an error message back to the player
            socket.emit('invalid_move', { error: moveResult.error });
        }
    });

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
        room.gameState.currentPlayer = playerColor === 1 ? 2 : 1;
        io.to(roomId).emit('update_game_state', room.gameState);
    });

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

// --- Server-Side Game Logic (Restored to full functionality) ---

function getNeighbors(r, c) {
    const neighbors = [];
    const deltas = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    for (const [dr, dc] of deltas) {
        const nr = r + dr, nc = c + dc;
        if (nr >= 0 && nr < 15 && nc >= 0 && nc < 15) {
            neighbors.push({ r: nr, c: nc });
        }
    }
    return neighbors;
}

function findGroupAndLiberties(r, c, color, boardState) {
    if (r < 0 || r >= 15 || c < 0 || c >= 15 || boardState[r][c] !== color) {
        return { group: [], libertiesCount: 0 };
    }
    const group = [];
    const liberties = new Set();
    const visited = {};
    const queue = [{ r, c }];
    visited[`${r},${c}`] = true;

    while (queue.length > 0) {
        const current = queue.pop();
        group.push(current);
        getNeighbors(current.r, current.c).forEach(n => {
            const key = `${n.r},${n.c}`;
            if (visited[key]) return;
            visited[key] = true;
            const neighborState = boardState[n.r][n.c];
            if (neighborState === 0) {
                liberties.add(key);
            } else if (neighborState === color) {
                queue.push(n);
            }
        });
    }
    return { group, libertiesCount: liberties.size };
}

function handleMoveServer(gameState, r, c) {
    const { boardState, currentPlayer, playerNames, moveCounts } = gameState;
    if (boardState[r][c] !== 0) return { success: false, error: "จุดนี้มีหมากแล้ว" };

    const opponent = currentPlayer === 1 ? 2 : 1;
    const tempBoard = JSON.parse(JSON.stringify(boardState));
    tempBoard[r][c] = currentPlayer;
    
    let capturedStonesCount = 0;
    getNeighbors(r, c).forEach(n => {
        if (tempBoard[n.r][n.c] === opponent) {
            const { group, libertiesCount } = findGroupAndLiberties(n.r, n.c, opponent, tempBoard);
            if (libertiesCount === 0) {
                capturedStonesCount += group.length;
                group.forEach(stone => { tempBoard[stone.r][stone.c] = 0; });
            }
        }
    });

    if (capturedStonesCount === 0) {
        const { libertiesCount } = findGroupAndLiberties(r, c, currentPlayer, tempBoard);
        if (libertiesCount === 0) {
            return { success: false, error: "ไม่สามารถวางหินในจุดฆ่าตัวตายได้" };
        }
    }

    // Move is valid, update the real game state
    gameState.boardState = tempBoard;
    gameState.capturedStones[currentPlayer] += capturedStonesCount;
    gameState.moveCounts[currentPlayer]--;
    gameState.currentPlayer = opponent;
    gameState.passes = 0; // Reset pass count on a valid move

    return { success: true, captured: capturedStonesCount };
}

function createInitialGameState(hostName, challengerName) {
    let board = Array(15).fill(0).map(() => Array(15).fill(0));
    const center = Math.floor(15 / 2);
    board[center - 1][center] = 1; board[center + 1][center] = 1;
    board[center][center - 1] = 2; board[center][center + 1] = 2;
    return {
        boardState: board, currentPlayer: 1, capturedStones: { '1': 0, '2': 0 },
        moveCounts: { '1': 100, '2': 100 }, passes: 0, koPoint: null,
        passCounts: { '1': 0, '2': 0 },
        playerNames: { '1': challengerName, '2': hostName }
    };
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
