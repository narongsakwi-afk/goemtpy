const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, '')));

// -- STATE MANAGEMENT --
// In-memory database for our game state
let players = {}; // { socketId: { name, currentRoomId } }
let rooms = {};   // { roomId: { ...roomData, gameState } }

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // --- LOBBY EVENTS ---
    socket.on('player_online', (playerName) => {
        players[socket.id] = { name: playerName, currentRoomId: null };
        io.emit('update_online_players', Object.values(players).map(p => p.name));
    });

    socket.on('get_rooms', () => {
        socket.emit('update_room_list', Object.values(rooms));
    });
    
    socket.on('create_room', (roomData) => {
        const roomId = `room_${socket.id}`;
        rooms[roomId] = { ...roomData, id: roomId, hostSocket: socket.id };
        if(players[socket.id]) players[socket.id].currentRoomId = roomId;
        socket.join(roomId); 
        io.emit('update_room_list', Object.values(rooms));
        socket.emit('joined_room', rooms[roomId]);
    });
    
    socket.on('join_room', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (room && !room.challenger) {
            room.challenger = playerName;
            room.challengerSocket = socket.id;
            if(players[socket.id]) players[socket.id].currentRoomId = roomId;
            socket.join(roomId);
            io.to(roomId).emit('player_joined', room);
            io.emit('update_room_list', Object.values(rooms));
        }
    });

    // --- WAITING ROOM EVENTS ---
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

    // --- IN-GAME ACTION EVENTS (FIXED & ROBUST) ---
    socket.on('make_move', ({ roomId, r, c }) => {
        const room = rooms[roomId];
        const player = players[socket.id];
        if (!room || !room.gameState || !player) return;
        
        const playerColor = room.gameState.playerNames['1'] === player.name ? 1 : 2;
        if (room.gameState.currentPlayer !== playerColor) return;

        const moveResult = handleMoveServer(room.gameState, r, c);
        
        if (moveResult.success) {
            // Check win conditions after a successful move
            if (checkForWin(roomId, playerColor)) return;
            // If no win, update everyone
            io.to(roomId).emit('update_game_state', room.gameState);
        } else if (moveResult.error) {
            socket.emit('invalid_move', { error: moveResult.error });
        }
    });

    socket.on('pass_move', (roomId) => {
        const room = rooms[roomId];
        const player = players[socket.id];
        if (!room || !room.gameState || !player) return;

        const playerColor = room.gameState.playerNames['1'] === player.name ? 1 : 2;
        if (room.gameState.currentPlayer !== playerColor) return;

        room.gameState.passCounts[playerColor]++;
        if (room.gameState.passCounts[playerColor] >= 5) {
            const winnerName = room.gameState.playerNames[playerColor === 1 ? 2 : 1];
            endGame(roomId, winnerName, `ฝ่ายตรงข้ามผ่านครบ 5 ครั้ง`);
            return;
        }
        room.gameState.currentPlayer = playerColor === 1 ? 2 : 1;
        io.to(roomId).emit('update_game_state', room.gameState);
    });

    socket.on('surrender', (roomId) => {
        const room = rooms[roomId];
        const player = players[socket.id];
        if (!room || !room.gameState || !player) return;

        const playerColor = room.gameState.playerNames['1'] === player.name ? 1 : 2;
        const winnerName = room.gameState.playerNames[playerColor === 1 ? 2 : 1];
        endGame(roomId, winnerName, `ฝ่ายตรงข้ามยอมแพ้`);
    });
    
    socket.on('leave_room', (roomId) => {
        handleDisconnect(socket.id);
        socket.emit('redirect_to_lobby');
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket.id);
    });
});

// --- HELPER FUNCTIONS ---
function handleDisconnect(socketId) {
    const player = players[socketId];
    if (player) {
        console.log(`Player ${player.name} disconnected: ${socketId}`);
        const roomId = player.currentRoomId;

        // If player was in a room, handle the logic
        if (roomId && rooms[roomId]) {
            const room = rooms[roomId];
            const winnerName = room.hostSocket === socketId ? room.challenger : room.host;
            
            // If the game had started, the other player wins
            if (room.gameStarted) {
                 endGame(roomId, winnerName, 'ฝ่ายตรงข้ามออกจากเกม');
            } else {
                // If game not started, just remove the room or player
                delete rooms[roomId];
            }
        }
        
        delete players[socketId];
        io.emit('update_online_players', Object.values(players).map(p => p.name));
        io.emit('update_room_list', Object.values(rooms));
    }
}

function endGame(roomId, winnerName, reason) {
    io.to(roomId).emit('game_over', { winner: winnerName, reason: reason });
    delete rooms[roomId]; // Clean up the room from memory
}

function checkForWin(roomId, playerColor) {
    const room = rooms[roomId];
    if (!room) return false;

    const { gameState } = room;
    
    // Rule 3: All stones captured
    const counts = countStonesOnBoard(gameState.boardState);
    const opponentColor = playerColor === 1 ? 2 : 1;
    if (counts[opponentColor] === 0) {
        endGame(roomId, gameState.playerNames[playerColor], `จับหมากของฝ่ายตรงข้ามได้ทั้งหมด`);
        return true;
    }

    // Rule 1: Move limit reached
    if (gameState.moveCounts[1] <= 0 || gameState.moveCounts[2] <= 0) {
        const finalCounts = countStonesOnBoard(gameState.boardState);
        let winnerName = 'เสมอ', reason = `มีหมากบนกระดานเท่ากัน`;
        if (finalCounts[1] > finalCounts[2]) {
            winnerName = gameState.playerNames[1];
            reason = `มีหมากบนกระดานมากกว่า (${finalCounts[1]} ต่อ ${finalCounts[2]})`;
        } else if (finalCounts[2] > finalCounts[1]) {
            winnerName = gameState.playerNames[2];
            reason = `มีหมากบนกระดานมากกว่า (${finalCounts[2]} ต่อ ${finalCounts[1]})`;
        }
        endGame(roomId, winnerName, reason);
        return true;
    }
    return false;
}

// ... The rest of the game logic functions (getNeighbors, findGroupAndLiberties, etc.) remain the same ...
// [You can copy them from the previous version, or use the full block below]
function getNeighbors(r, c) {const n=[],d=[[0,1],[0,-1],[1,0],[-1,0]];for(const[t,a]of d){const o=r+t,e=c+a;o>=0&&o<15&&e>=0&&e<15&&n.push({r:o,c:e})}return n}
function findGroupAndLiberties(r, c, color, boardState) {if(r<0||r>=15||c<0||c>=15||!boardState[r]||boardState[r][c]!==color)return{group:[],libertiesCount:0};const group=[],liberties=new Set,visited={},queue=[{r,c}];visited[`${r},${c}`]=!0;while(queue.length>0){const current=queue.pop();group.push(current);getNeighbors(current.r,current.c).forEach(n=>{const key=`${n.r},${n.c}`;if(visited[key])return;const neighborState=boardState[n.r][n.c];0===neighborState?liberties.add(key):neighborState===color&&(visited[key]=!0,queue.push(n))})}return{group,libertiesCount:liberties.size}}
function handleMoveServer(gameState, r, c) {const{boardState,currentPlayer}=gameState;if(0!==boardState[r][c])return{success:!1,error:"จุดนี้มีหมากแล้ว"};const opponent=1===currentPlayer?2:1,tempBoard=JSON.parse(JSON.stringify(boardState));tempBoard[r][c]=currentPlayer;let capturedStonesCount=0;getNeighbors(r,c).forEach(n=>{if(tempBoard[n.r][n.c]===opponent){const{group,libertiesCount}=findGroupAndLiberties(n.r,n.c,opponent,tempBoard);0===libertiesCount&&(capturedStonesCount+=group.length,group.forEach(stone=>{tempBoard[stone.r][stone.c]=0}))}});if(0===capturedStonesCount){const{libertiesCount}=findGroupAndLiberties(r,c,currentPlayer,tempBoard);if(0===libertiesCount)return{success:!1,error:"ไม่สามารถวางหินในจุดฆ่าตัวตายได้"}}return gameState.boardState=tempBoard,gameState.capturedStones[currentPlayer]+=capturedStonesCount,gameState.moveCounts[currentPlayer]--,gameState.currentPlayer=opponent,gameState.passes=0,{success:!0,captured:capturedStonesCount}}
function createInitialGameState(hostName, challengerName) {let board=Array(15).fill(0).map(()=>Array(15).fill(0));const center=Math.floor(15/2);return board[center-1][center]=1,board[center+1][center]=1,board[center][center-1]=2,board[center+1][center]=2,{boardState:board,currentPlayer:1,capturedStones:{1:0,2:0},moveCounts:{1:100,2:100},passes:0,koPoint:null,passCounts:{1:0,2:0},playerNames:{1:challengerName,2:hostName}}}
function countStonesOnBoard(boardState) {const counts={1:0,2:0};for(let r=0;r<15;r++)for(let c=0;c<15;c++)1===boardState[r][c]?counts[1]++:2===boardState[r][c]&&counts[2]++;return counts}


server.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});
