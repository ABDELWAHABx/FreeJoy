import { IPlugin } from './IPlugin';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';

export class RyujinxPlugin implements IPlugin {
    name = "Ryujinx Virtual Gamepad";
    version = "7.0.0-VGAMEPAD";
    // Players 1-4 get Xbox 360 pads. Players 5+ get DualShock 4 pads because
    // Windows XInput only exposes four Xbox controllers (see virtual_gamepad.py).
    maxPlayers = readMaxPlayers();
    private pythonProcess: ChildProcess | null = null;
    private stopping = false;

    constructor() {
        console.log('[Ryujinx] Initializing Virtual Gamepad Plugin...');
    }

    async init(): Promise<void> {
        console.log('[Ryujinx] Starting Python VGamepad Service...');

        const pythonScript = path.join(__dirname, '../python/virtual_gamepad.py');

        // Spawn Python process
        this.pythonProcess = spawn(process.env.FREEJOY_PYTHON || 'python', [pythonScript], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Log Python stderr (where vgamepad logs go)
        this.pythonProcess.stderr?.on('data', (data) => {
            console.log(`[Python] ${data.toString().trim()}`);
        });

        // Log Python stdout
        this.pythonProcess.stdout?.on('data', (data) => {
            console.log(`[Python OUT] ${data.toString().trim()}`);
        });

        this.pythonProcess.on('error', (err) => {
            console.error('[Ryujinx] Python process error:', err);
            process.exit(1);
        });

        this.pythonProcess.on('exit', (code, signal) => {
            console.log(`[Ryujinx] Python process exited with code ${code}, signal ${signal}`);
            this.pythonProcess = null;
            if (!this.stopping) process.exit(1);
        });

        console.log('[Ryujinx] Python VGamepad Service started');
    }

    async cleanup(): Promise<void> {
        this.stopping = true;
        console.log('[Ryujinx] Cleaning up Python process...');
        const child = this.pythonProcess;
        if (!child) return;

        // Closing stdin lets the Python loop reach its finally block and reset
        // every remaining virtual controller before a forced termination.
        await new Promise<void>((resolve) => {
            let completed = false;
            const finish = () => {
                if (completed) return;
                completed = true;
                clearTimeout(forceTimer);
                resolve();
            };
            const forceTimer = setTimeout(() => {
                child.kill();
                finish();
            }, 2_000);
            child.once('exit', finish);
            child.stdin?.end();
        });
        this.pythonProcess = null;
    }

    initPlayer(playerIndex: number): void {
        console.log(`[Ryujinx] Initializing controller for Player ${playerIndex}`);
        this.sendCommand({
            action: 'init',
            playerId: playerIndex
        });
    }

    private sendCommand(cmd: object): void {
        if (!this.pythonProcess || !this.pythonProcess.stdin) {
            console.error('[Ryujinx] Python process not available');
            return;
        }

        try {
            const json = JSON.stringify(cmd) + '\n';
            this.pythonProcess.stdin.write(json);
        } catch (err) {
            console.error('[Ryujinx] Failed to send command to Python:', err);
        }
    }

    sendButtonPress(playerIndex: number, button: string, pressed: boolean): void {
        if (process.env.FREEJOY_DEBUG_INPUT === '1') console.log(`[Ryujinx] P${playerIndex} ${button} ${pressed ? 'pressed' : 'released'}`);
        this.sendCommand({
            action: 'button',
            playerId: playerIndex,
            button: button,
            pressed: pressed
        });
    }

    sendAnalogInput(playerIndex: number, stick: 'left' | 'right', x: number, y: number): void {
        if (process.env.FREEJOY_DEBUG_INPUT === '1') console.log(`[Ryujinx] P${playerIndex} ${stick}_stick X:${x.toFixed(2)} Y:${y.toFixed(2)}`);
        this.sendCommand({
            action: 'analog',
            playerId: playerIndex,
            stick: stick,
            x: x,
            y: y
        });
    }

    getPlayerProfile(playerIndex: number) {
        // Always return Pro Controller profile for all players
        return {
            type: 'pro'
        };
    }

    setActivePlayer(playerIndex: number): void {
        // Not needed for vgamepad approach
    }

    getActivePlayer(): number {
        return 1; // Not used
    }

    releasePlayer(playerIndex: number): void {
        console.log(`[Ryujinx] Releasing controller for Player ${playerIndex}`);
        this.sendCommand({
            action: 'disconnect',
            playerId: playerIndex
        });
    }
}

function readMaxPlayers(): number {
    const raw = process.env.FREEJOY_MAX_PLAYERS;
    if (!raw) return 8;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 16) {
        throw new Error('FREEJOY_MAX_PLAYERS must be an integer between 1 and 16');
    }
    return value;
}
