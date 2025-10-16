const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '')));

let players = {};
let rooms = {};

io.on('connection', (socket) => {
    console.log(`[Server] User connected: ${socket.id}`);

    socket.on('player_online', (playerName) => {
        console.log(`[Server] Event 'player_online' received for ${playerName}`);
        players[socket.id] = { name: playerName, currentRoomId: null };
        io.emit('update_online_players', Object.values(players).map(p => p.name));
    });

    socket.on('create_room', (roomData) => {
        console.log(`[Server] Event 'create_room' received from ${roomData.host}`);
        const roomId = `room_${socket.id}`;
        rooms[roomId] = { ...roomData, id: roomId, hostSocket: socket.id };
        if(players[socket.id]) players[socket.id].currentRoomId = roomId;
        socket.join(roomId);
        io.emit('update_room_list', Object.values(rooms));
        io.to(roomId).emit('update_waiting_room', rooms[roomId]);
    });

    socket.on('join_room', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        console.log(`[Server] Event 'join_room' received for room ${roomId} by ${playerName}`);
        if (room && !room.challenger) {
            room.challenger = playerName;
            room.challengerSocket = socket.id;
            if(players[socket.id]) players[socket.id].currentRoomId = roomId;
            socket.join(roomId);
            io.to(roomId).emit('update_waiting_room', room);
            io.emit('update_room_list', Object.values(rooms));
        }
    });

    socket.on('start_game', (roomId) => {
        console.log(`[Server] Event 'start_game' received for room ${roomId}`);
        const room = rooms[roomId];
        if (room && room.challengerReady) {
            room.gameStarted = true;
            room.gameState = createInitialGameState(room.host, room.challenger);
            io.to(roomId).emit('game_started', room);
            io.emit('update_room_list', Object.values(rooms));
        }
    });

    socket.on('make_move', ({ roomId, r, c }) => {
        const player = players[socket.id];
        console.log(`[Server] Event 'make_move' received from ${player ? player.name : 'Unknown'}`);
        const room = rooms[roomId];
        if (!room || !room.gameState || !player) {
            console.error('[Server ERROR] make_move failed: Room, GameState, or Player not found.');
            return;
        }
        
        const playerColor = room.gameState.playerNames['1'] === player.name ? 1 : 2;
        if (room.gameState.currentPlayer !== playerColor) {
            console.warn(`[Server] Invalid turn for ${player.name}`);
            return;
        }

        const moveResult = handleMoveServer(room.gameState, r, c);
        if (moveResult.success) {
            console.log(`[Server] Move successful by ${player.name}. Broadcasting update.`);
            io.to(roomId).emit('update_game_state', room.gameState);
        } else {
            socket.emit('invalid_move', { error: moveResult.error });
        }
    });

    socket.on('pass_move', (roomId) => {
        const player = players[socket.id];
        console.log(`[Server] Event 'pass_move' received from ${player ? player.name : 'Unknown'}`);
        const room = rooms[roomId];
        if (!room || !room.gameState || !player) {
            console.error('[Server ERROR] pass_move failed: Room, GameState, or Player not found.');
            return;
        }
        
        const playerColor = room.gameState.playerNames['1'] === player.name ? 1 : 2;
        if (room.gameState.currentPlayer !== playerColor) return;
        
        room.gameState.currentPlayer = playerColor === 1 ? 2 : 1;
        console.log(`[Server] Pass successful by ${player.name}. Broadcasting update.`);
        io.to(roomId).emit('update_game_state', room.gameState);
    });

    socket.on('surrender', (roomId) => {
        const player = players[socket.id];
        console.log(`[Server] Event 'surrender' received from ${player ? player.name : 'Unknown'}`);
        const room = rooms[roomId];
        if (!room || !room.gameState || !player) {
            console.error('[Server ERROR] surrender failed: Room, GameState, or Player not found.');
            return;
        }
        
        const playerColor = room.gameState.playerNames['1'] === player.name ? 1 : 2;
        const winnerName = room.gameState.playerNames[playerColor === 1 ? 2 : 1];
        endGame(roomId, winnerName, `ฝ่ายตรงข้ามยอมแพ้`);
    });
    
    socket.on('leave_room', () => {
        console.log(`[Server] Event 'leave_room' received from ${socket.id}`);
        handleDisconnect(socket.id);
    });

    socket.on('disconnect', () => {
        console.log(`[Server] User disconnected: ${socket.id}`);
        handleDisconnect(socket.id);
    });
});

function handleDisconnect(socketId) {
    const player = players[socketId];
    if (player) {
        const roomId = player.currentRoomId;
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const winnerName = room.hostSocket === socketId ? room.challenger : room.host;
            if (room.gameStarted) {
                 endGame(roomId, winnerName, 'ฝ่ายตรงข้ามออกจากเกม');
            } else {
                delete rooms[roomId];
            }
        }
        delete players[socketId];
        io.emit('update_online_players', Object.values(players).map(p => p.name));
        io.emit('update_room_list', Object.values(rooms));
    }
}

function endGame(roomId, winnerName, reason) {
    const room = rooms[roomId];
    if (room) {
        console.log(`[Server] Game Over in room ${roomId}. Winner: ${winnerName}`);
        io.to(roomId).emit('game_over', { winner: winnerName, reason: reason });
        delete rooms[roomId];
    }
}

// ... The rest of the game logic functions are the same ...
function getNeighbors(r,c){const n=[],d=[[0,1],[0,-1],[1,0],[-1,0]];for(const[t,a]of d){const o=r+t,e=c+a;o>=0&&o<15&&e>=0&&e<15&&n.push({r:o,c:e})}return n}
function findGroupAndLiberties(r,c,o,t){if(r<0||r>=15||c<0||c>=15||!t[r]||t[r][c]!==o)return{group:[],libertiesCount:0};const e=[],i=new Set,s={},u=[{r,c}];s[`${r},${c}`]=!0;while(u.length>0){const r=u.pop();e.push(r);getNeighbors(r.r,r.c).forEach(r=>{const c=`${r.r},${r.c}`;if(s[c])return;const n=t[r.r][r.c];0===n?i.add(c):n===o&&(s[c]=!0,u.push(r))})}return{group:e,libertiesCount:i.size}}
function handleMoveServer(o,t,e){const{boardState:r,currentPlayer:s}=o;if(0!==r[t][e])return{success:!1,error:"จุดนี้มีหมากแล้ว"};const n=1===s?2:1,u=JSON.parse(JSON.stringify(r));u[t][e]=s;let a=0;return getNeighbors(t,e).forEach(r=>{if(u[r.r][r.c]===n){const{group:t,libertiesCount:e}=findGroupAndLiberties(r.r,r.c,n,u);0===e&&(a+=t.length,t.forEach(o=>{u[o.r][o.c]=0}))}}),0===a&&0===(findGroupAndLiberties(t,e,s,u).libertiesCount)&&{success:!1,error:"ไม่สามารถวางหินในจุดฆ่าตัวตายได้"},o.boardState=u,o.capturedStones[s]+=a,o.moveCounts[s]--,o.currentPlayer=n,o.passes=0,{success:!0,captured:a}}
function createInitialGameState(o,t){let e=Array(15).fill(0).map(()=>Array(15).fill(0));const r=Math.floor(15/2);return e[r-1][r]=1,e[r+1][r]=1,e[r][r-1]=2,e[r][r+1]=2,{boardState:e,currentPlayer:1,capturedStones:{1:0,2:0},moveCounts:{1:100,2:100},passes:0,koPoint:null,passCounts:{1:0,2:0},playerNames:{1:t,2:o}}}

server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
