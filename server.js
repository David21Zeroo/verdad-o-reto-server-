const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));

// Almacenamiento de salas en memoria (en producción usar Redis)
const rooms = new Map();

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = '';
        for (let i = 0; i < 6; i++) {
            code += chars.charAt(Math.floor(Math.random() * chars.length));
        }
    } while (rooms.has(code));
    return code;
}

io.on('connection', (socket) => {
    console.log('Nuevo cliente conectado:', socket.id);

    // Crear sala
    socket.on('create_room', (data) => {
        const roomCode = generateRoomCode();
        const room = {
            code: roomCode,
            players: [{
                id: socket.id,
                name: data.playerName,
                isHost: true
            }],
            gameStarted: false,
            currentTurn: null,
            scores: {},
            currentChallenge: null
        };
        
        rooms.set(roomCode, room);
        socket.join(roomCode);
        socket.roomCode = roomCode;
        
        console.log(`Sala creada: ${roomCode} por ${data.playerName}`);
        socket.emit('room_created', { roomCode });
    });

    // Unirse a sala
    socket.on('join_room', (data) => {
        const room = rooms.get(data.roomCode);
        
        if (!room) {
            socket.emit('error', { code: 'ROOM_NOT_FOUND', message: 'Sala no encontrada' });
            return;
        }
        
        if (room.players.length >= 2) {
            socket.emit('error', { code: 'ROOM_FULL', message: 'La sala está llena' });
            return;
        }
        
        if (room.gameStarted) {
            socket.emit('error', { code: 'GAME_STARTED', message: 'El juego ya comenzó' });
            return;
        }

        room.players.push({
            id: socket.id,
            name: data.playerName,
            isHost: false
        });
        
        socket.join(data.roomCode);
        socket.roomCode = data.roomCode;
        
        console.log(`${data.playerName} se unió a la sala ${data.roomCode}`);
        
        // Notificar al nuevo jugador
        socket.emit('joined_room', {
            roomCode: data.roomCode,
            players: room.players
        });
        
        // Notificar al anfitrión
        socket.to(data.roomCode).emit('player_joined', {
            playerName: data.playerName,
            players: room.players
        });
    });

    // Iniciar juego
    socket.on('start_game', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || room.players.length !== 2) return;
        
        const host = room.players.find(p => p.isHost);
        if (host.id !== socket.id) return; // Solo el host puede iniciar
        
        room.gameStarted = true;
        room.currentTurn = room.players[Math.floor(Math.random() * 2)].id;
        
        // Inicializar scores
        room.players.forEach(p => {
            room.scores[p.id] = 0;
        });
        
        console.log(`Juego iniciado en sala ${data.roomCode}`);
        
        io.to(data.roomCode).emit('game_started', {
            currentTurn: room.currentTurn,
            scores: room.scores
        });
    });

    // Girar botella
    socket.on('spin_bottle', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || !room.gameStarted) return;
        
        if (room.currentTurn !== socket.id) return; // Solo el jugador en turno puede girar
        
        const rotation = 1440 + Math.floor(Math.random() * 360);
        const winner = room.players[Math.floor(Math.random() * 2)].id;
        
        room.currentTurn = winner;
        room.currentChallenge = null;
        
        console.log(`Botella girada en ${data.roomCode}, ganador: ${winner}`);
        
        io.to(data.roomCode).emit('bottle_spun', {
            rotation: rotation,
            winner: winner
        });
    });

    // Seleccionar desafío
    socket.on('select_challenge', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || !room.gameStarted) return;
        
        if (room.currentTurn !== socket.id) return;
        
        room.currentChallenge = {
            type: data.type,
            text: data.challenge,
            playerId: socket.id
        };
        
        const player = room.players.find(p => p.id === socket.id);
        
        console.log(`Desafío seleccionado en ${data.roomCode}: ${data.type}`);
        
        io.to(data.roomCode).emit('challenge_selected', {
            type: data.type,
            challenge: data.challenge,
            playerName: player.name,
            playerId: socket.id
        });
    });

    // Completar desafío
    socket.on('complete_challenge', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || !room.gameStarted) return;
        
        if (room.currentTurn !== socket.id) return;
        
        room.scores[socket.id] = (room.scores[socket.id] || 0) + 1;
        
        const player = room.players.find(p => p.id === socket.id);
        
        console.log(`Desafío completado por ${player.name} en ${data.roomCode}`);
        
        io.to(data.roomCode).emit('challenge_completed', {
            playerId: socket.id,
            playerName: player.name,
            scores: room.scores
        });
        
        // Cambiar turno al otro jugador
        const otherPlayer = room.players.find(p => p.id !== socket.id);
        room.currentTurn = otherPlayer.id;
        room.currentChallenge = null;
        
        setTimeout(() => {
            io.to(data.roomCode).emit('turn_changed', {
                currentTurn: room.currentTurn
            });
        }, 2000);
    });

    // Pasar desafío
    socket.on('skip_challenge', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room || !room.gameStarted) return;
        
        if (room.currentTurn !== socket.id) return;
        
        const player = room.players.find(p => p.id === socket.id);
        
        console.log(`Desafío pasado por ${player.name} en ${data.roomCode}`);
        
        io.to(data.roomCode).emit('challenge_skipped', {
            playerId: socket.id,
            playerName: player.name
        });
        
        // Cambiar turno al otro jugador
        const otherPlayer = room.players.find(p => p.id !== socket.id);
        room.currentTurn = otherPlayer.id;
        room.currentChallenge = null;
        
        setTimeout(() => {
            io.to(data.roomCode).emit('turn_changed', {
                currentTurn: room.currentTurn
            });
        }, 2000);
    });

    // Desconexión
    socket.on('disconnect', () => {
        console.log('Cliente desconectado:', socket.id);
        
        if (socket.roomCode) {
            const room = rooms.get(socket.roomCode);
            if (room) {
                const player = room.players.find(p => p.id === socket.id);
                if (player) {
                    io.to(socket.roomCode).emit('player_disconnected', {
                        playerName: player.name
                    });
                }
                
                // Eliminar sala después de un tiempo si está vacía
                setTimeout(() => {
                    const updatedRoom = rooms.get(socket.roomCode);
                    if (updatedRoom) {
                        const stillConnected = updatedRoom.players.filter(p => {
                            const socketExists = io.sockets.sockets.get(p.id);
                            return socketExists && socketExists.connected;
                        });
                        
                        if (stillConnected.length === 0) {
                            rooms.delete(socket.roomCode);
                            console.log(`Sala ${socket.roomCode} eliminada por inactividad`);
                        }
                    }
                }, 30000); // 30 segundos de gracia
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor corriendo en puerto ${PORT}`);
});

