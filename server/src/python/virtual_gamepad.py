#!/usr/bin/env python3
"""
Virtual Gamepad Controller for Ryujinx
Uses vgamepad to create virtual Xbox 360 controllers on Windows.
Controlled via stdin JSON messages from Node.js server.
"""

import os
import sys
import json
import vgamepad as vg
from typing import Dict

# Global controller pool (player_id -> VX360Gamepad instance)
controllers: Dict[int, vg.VX360Gamepad] = {}

# Button mapping: Switch Pro Controller -> Xbox 360
BUTTON_MAP = {
    'A': vg.XUSB_BUTTON.XUSB_GAMEPAD_B,           # Switch A = Xbox B (position)
    'B': vg.XUSB_BUTTON.XUSB_GAMEPAD_A,           # Switch B = Xbox A (position)
    'X': vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,           # Switch X = Xbox Y (position)
    'Y': vg.XUSB_BUTTON.XUSB_GAMEPAD_X,           # Switch Y = Xbox X (position)
    'L': vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
    'R': vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
    'ZL': 'LEFT_TRIGGER',                          # Analog trigger
    'ZR': 'RIGHT_TRIGGER',                         # Analog trigger
    'Plus': vg.XUSB_BUTTON.XUSB_GAMEPAD_START,
    'Minus': vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,
    'L3': vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_THUMB,
    'R3': vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_THUMB,
    'DPadUp': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,
    'DPadDown': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
    'DPadLeft': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,
    'DPadRight': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
    'SL': vg.XUSB_BUTTON.XUSB_GAMEPAD_GUIDE,       # Map SL to Guide button
    'SR': vg.XUSB_BUTTON.XUSB_GAMEPAD_GUIDE,       # Map SR to Guide button
}


def get_or_create_controller(player_id: int) -> vg.VX360Gamepad:
    """Get existing controller or create new one for player."""
    if player_id not in controllers:
        controllers[player_id] = vg.VX360Gamepad()
        log(f"Created virtual gamepad for Player {player_id}")
    return controllers[player_id]


def handle_button(player_id: int, button: str, pressed: bool):
    """Handle button press/release."""
    gamepad = get_or_create_controller(player_id)
    
    if button not in BUTTON_MAP:
        log(f"Unknown button: {button}")
        return
    
    mapping = BUTTON_MAP[button]
    
    # Handle triggers separately (analog 0-255)
    if mapping == 'LEFT_TRIGGER':
        gamepad.left_trigger(255 if pressed else 0)
    elif mapping == 'RIGHT_TRIGGER':
        gamepad.right_trigger(255 if pressed else 0)
    else:
        # Digital button
        if pressed:
            gamepad.press_button(mapping)
        else:
            gamepad.release_button(mapping)
    
    gamepad.update()
    if os.environ.get("FREEJOY_DEBUG_INPUT") == "1": log(f"P{player_id} {button} {'pressed' if pressed else 'released'}")


def handle_analog(player_id: int, stick: str, x: float, y: float):
    """Handle analog stick input."""
    gamepad = get_or_create_controller(player_id)

    # Keep the native driver boundary safe even if a future caller bypasses the
    # TypeScript protocol validator.
    x = max(-1.0, min(1.0, float(x)))
    y = max(-1.0, min(1.0, float(y)))
    
    # Convert from -1.0 to 1.0 range to -32768 to 32767 range
    x_int = int(x * 32767)
    y_int = int(-y * 32767)  # Invert Y axis (up is positive in vgamepad)
    
    if stick == 'left':
        gamepad.left_joystick(x_value=x_int, y_value=y_int)
    elif stick == 'right':
        gamepad.right_joystick(x_value=x_int, y_value=y_int)
    
    gamepad.update()
    if os.environ.get("FREEJOY_DEBUG_INPUT") == "1": log(f"P{player_id} {stick}_stick X:{x:.2f} Y:{y:.2f}")


def handle_disconnect(player_id: int):
    """Remove controller for disconnected player."""
    if player_id in controllers:
        # Reset controller to neutral state before removing
        gamepad = controllers[player_id]
        gamepad.reset()
        gamepad.update()
        del controllers[player_id]
        log(f"Removed virtual gamepad for Player {player_id}")


def log(message: str):
    """Log to stderr (stdout is used for IPC)."""
    print(f"[VGamepad] {message}", file=sys.stderr, flush=True)


def main():
    """Main loop - read JSON commands from stdin."""
    log("Virtual Gamepad Service Started")
    log("Waiting for commands...")
    
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            
            try:
                cmd = json.loads(line)
                action = cmd.get('action')
                player_id = cmd.get('playerId')
                
                if not player_id:
                    log(f"Missing playerId in command: {cmd}")
                    continue
                
                if action == 'button':
                    button = cmd.get('button')
                    pressed = cmd.get('pressed', False)
                    handle_button(player_id, button, pressed)
                
                elif action == 'analog':
                    stick = cmd.get('stick')
                    x = cmd.get('x', 0.0)
                    y = cmd.get('y', 0.0)
                    handle_analog(player_id, stick, x, y)
                
                elif action == 'init':
                    # Pre-create controller so emulator sees it
                    get_or_create_controller(player_id)
                    log(f"P{player_id} controller initialized")
                
                elif action == 'disconnect':
                    handle_disconnect(player_id)
                
                else:
                    log(f"Unknown action: {action}")
            
            except json.JSONDecodeError as e:
                log(f"JSON decode error: {e}")
            except Exception as e:
                log(f"Error processing command: {e}")
    
    except KeyboardInterrupt:
        log("Shutting down...")
    finally:
        # Cleanup all controllers
        for player_id in list(controllers.keys()):
            handle_disconnect(player_id)
        log("Cleanup complete")


if __name__ == "__main__":
    main()
