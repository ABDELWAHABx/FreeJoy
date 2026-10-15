import cors from 'cors';
import express, { Request } from 'express';
import fs from 'fs';
import { createServer } from 'http';
import path from 'path';
import { rateLimit } from 'express-rate-limit';
import { Server } from 'socket.io';
import { CapabilityAuthority, loadCapabilityConfig } from './authority';
import { RyujinxPlugin } from './plugins/RyujinxPlugin';
import { RoomManager } from './roomManager';
import { HostRoomState } from './types';
import { WSHandler } from './wsHandler';

export async function bootstrap(): Promise<void> {
    const app = express();
    const port = parseIntegerSetting('PORT', 3_000, 1, 65_535);
    const protocol = 'http';
    const capabilities = loadCapabilityConfig();
    const authority = new CapabilityAuthority(capabilities);
    const controllerLeaseMs = parseIntegerSetting(
        'FREEJOY_CONTROLLER_LEASE_MS',
        30_000,
        5_000,
        300_000
    );
    const cleanupIntervalMs = parseIntegerSetting(
        'FREEJOY_CLEANUP_INTERVAL_MS',
        Math.min(2_000, Math.floor(controllerLeaseMs / 3)),
        250,
        controllerLeaseMs
    );

    const plugin = new RyujinxPlugin();
    await plugin.init();

    const roomManager = new RoomManager(plugin.maxPlayers);
    const serverIp = roomManager.getServerIp();
    const createJoinUrl = () => `${protocol}://${serverIp}:${port}/pad#room=${encodeURIComponent(roomManager.roomId)}&join=${encodeURIComponent(authority.getJoinToken())}`;

    const httpServer = createServer(app);
    const io = new Server(httpServer, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST']
        }
    });
    const wsHandler = new WSHandler(io, roomManager, plugin, authority, {
        cleanupIntervalMs,
        staleTimeoutMs: controllerLeaseMs,
        maximumInputEventsPerSecond: parseIntegerSetting(
            'FREEJOY_INPUT_EVENTS_PER_SECOND',
            120,
            10,
            1_000
        )
    });
    wsHandler.init();

    app.use(cors());
    app.use(express.json({ limit: '16kb' }));

    const packagedClientPath = path.join(__dirname, 'public');
    const developmentClientPath = path.join(__dirname, '../../client/dist_build');
    const clientPath = fs.existsSync(path.join(packagedClientPath, 'index.html'))
        ? packagedClientPath
        : developmentClientPath;
    const clientIndexPath = path.join(clientPath, 'index.html');
    const clientIndexAvailable = fs.existsSync(clientIndexPath);
    const clientFallbackLimiter = rateLimit({
        windowMs: 60_000,
        limit: 120,
        standardHeaders: 'draft-8',
        legacyHeaders: false
    });
    app.use(express.static(clientPath));

    app.get('/api/room', (request, response) => {
        response.setHeader('Cache-Control', 'no-store');
        if (!authority.permitsHost(readBearerToken(request))) {
            response.status(403).json({
                code: 'HOST_AUTH_REQUIRED',
                message: 'A valid host capability is required.'
            });
            return;
        }

        const state: HostRoomState = {
            ...roomManager.getPublicState(),
            roomId: roomManager.roomId,
            serverIp,
            joinUrl: createJoinUrl()
        };
        response.json(state);
    });

    app.get('/{*splat}', clientFallbackLimiter, (request, response) => {
        if (request.accepts('html')) {
            if (clientIndexAvailable) {
                response.sendFile(clientIndexPath);
            } else {
                response.status(404).send('Client not built. Run `npm run build` in client folder.');
            }
        } else {
            response.status(404).send('Not Found');
        }
    });

    httpServer.listen(port, () => {
        console.log('==========================================');
        console.log('🎮 Wireless Gamepad Server Started (HTTP)');
        console.log('🔌 Plugin:', plugin.name);
        console.log('🏠 Room ID:', roomManager.roomId);
        console.log('🔐 Capability URLs are intentionally omitted from process logs.');
        console.log('🖥️  Use Launcher.ps1 or the configured host capability to open the host UI.');
        console.log('==========================================\n');
    });

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`[Server] ${signal} received; releasing controllers`);
        wsHandler.shutdown();
        io.disconnectSockets(true);
        await plugin.cleanup();
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    };

    app.post('/api/shutdown', (request, response) => {
        if (!authority.permitsHost(readBearerToken(request))) {
            response.sendStatus(403); return;
        }
        response.json({ stopping: true });
        setImmediate(() => void shutdown('host request'));
    });

    const launcherPid = Number(process.env.FREEJOY_LAUNCHER_PID);
    if (Number.isInteger(launcherPid) && launcherPid > 0) {
        const watchLauncher = setInterval(() => {
            try { process.kill(launcherPid, 0); }
            catch { clearInterval(watchLauncher); void shutdown('launcher closed'); }
        }, 2_000);
        watchLauncher.unref();
    }

    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

function readBearerToken(request: Request): string | undefined {
    const authorization = request.header('authorization');
    if (!authorization) return undefined;
    const [scheme, token, extra] = authorization.trim().split(/\s+/u);
    return scheme?.toLowerCase() === 'bearer' && token && !extra ? token : undefined;
}

function parseIntegerSetting(
    name: string,
    fallback: number,
    minimum: number,
    maximum: number
): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}

if (require.main === module) {
    bootstrap().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
