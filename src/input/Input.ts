// Unified keyboard, mouse and gamepad input with GTA V-style helicopter bindings.
//
//            Controller        Keyboard
// Throttle   RT / LT           W / S
// Yaw        LB / RB           A / D
// Pitch/roll Left stick        Arrow keys / Numpad 8-5-4-6
// Camera     Right stick       Mouse (click to capture)

export interface FlightInput {
  /** -1 descend .. +1 climb. */
  collective: number;
  /** -1 left .. +1 right. */
  yaw: number;
  /** -1 nose up (back) .. +1 nose down (forward). */
  pitch: number;
  /** -1 bank left .. +1 bank right. */
  roll: number;
}

export interface FrameInput extends FlightInput {
  /** Camera orbit rate from the right stick, -1..1. */
  lookX: number;
  lookY: number;
  /** Mouse movement in pixels since the last frame. */
  mouseX: number;
  mouseY: number;
  zoom: number;
  actions: Set<Action>;
  /** True when the last input that moved anything came from a controller. */
  usingGamepad: boolean;
}

export type Action =
  | 'map'
  | 'pause'
  | 'help'
  | 'searchlight'
  | 'camera'
  | 'timeFaster'
  | 'timeSlower'
  | 'next'
  | 'prev'
  // Arrow keys and the d-pad report separately: arrows also fly, the d-pad also sets time speed.
  | 'arrowUp'
  | 'arrowDown'
  | 'arrowLeft'
  | 'arrowRight'
  | 'dpadUp'
  | 'dpadDown'
  | 'dpadLeft'
  | 'dpadRight'
  | 'ltPress'
  | 'rtPress'
  | 'back'
  | 'padDebug'
  /** Start or stop the selected ground operation. */
  | 'confirm'
  /** Let go of the slung fuel bladder. */
  | 'sling'
  | `overlay${number}`;

const KEY_ACTIONS: Record<string, Action> = {
  KeyM: 'map',
  Escape: 'pause',
  KeyP: 'pause',
  KeyH: 'help',
  KeyL: 'searchlight',
  KeyC: 'camera',
  KeyG: 'padDebug',
  KeyE: 'confirm',
  KeyF: 'sling',
  Enter: 'confirm',
  BracketRight: 'timeFaster',
  BracketLeft: 'timeSlower',
  Tab: 'next',
};

// Standard gamepad mapping (https://w3c.github.io/gamepad/#remapping).
const PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
const PAD_ACTIONS: [number, Action][] = [
  [PAD.VIEW, 'map'],
  [PAD.MENU, 'pause'],
  [PAD.A, 'confirm'],
  [PAD.X, 'sling'],
  [PAD.Y, 'searchlight'],
  [PAD.R3, 'camera'],
  [PAD.RB, 'next'],
  [PAD.LB, 'prev'],
  [PAD.UP, 'dpadUp'],
  [PAD.DOWN, 'dpadDown'],
  [PAD.LEFT, 'dpadLeft'],
  [PAD.RIGHT, 'dpadRight'],
  [PAD.LT, 'ltPress'],
  [PAD.RT, 'rtPress'],
  [PAD.B, 'back'],
];

const STICK_DEADZONE = 0.15;
const TRIGGER_DEADZONE = 0.05;
/** Chromium sometimes reports huge pointer-lock jumps; ignore anything bigger than this. */
const MOUSE_SPIKE = 200;

/**
 * How a pad's raw axes and buttons map onto the standard Xbox layout.
 * - standard: the browser already remapped it (most Xbox/PlayStation pads on Windows).
 * - xinput: the common unmapped Xbox layout (Linux and some Bluetooth connections), where
 *   the triggers are axes and the right stick is on axes 3 and 4.
 */
type Layout = 'standard' | 'xinput';

interface PadState {
  id: string;
  layout: Layout;
  /** An axis only counts once it has been seen at rest, so stuck or uncalibrated axes can't spin the camera. */
  armed: boolean[];
  /** Action buttons last frame, for press edges. */
  prev: boolean[];
  /** All buttons last frame, to notice a pad being picked up. */
  held: boolean[];
}

export interface PadReading {
  id: string;
  layout: Layout;
  axes: readonly number[];
  pressed: number[];
}

interface LogicalPad {
  lx: number;
  ly: number;
  rx: number;
  ry: number;
  lt: number;
  rt: number;
  buttons: boolean[];
}

/** Radial deadzone, rescaled so output still starts at 0 and reaches 1. */
function stick(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len < STICK_DEADZONE) return [0, 0];
  const scaled = Math.min(1, (len - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return [(x / len) * scaled, (y / len) * scaled];
}

const trigger = (v: number) => (v < TRIGGER_DEADZONE ? 0 : (v - TRIGGER_DEADZONE) / (1 - TRIGGER_DEADZONE));

export class Input {
  onGamepadChange: (name: string | null) => void = () => {};

  private down = new Set<string>();
  private pressed = new Set<Action>();
  private mouseX = 0;
  private mouseY = 0;
  private wheel = 0;
  private pads = new Map<number, PadState>();
  private activePad: number | null = null;
  private usingGamepad = false;
  /** Raw view of the active pad, for the on-screen controller readout. */
  lastPad: PadReading | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (e.code.startsWith('Arrow') || e.code === 'Space' || e.code === 'Tab') e.preventDefault();
      if (!e.repeat) {
        const action = KEY_ACTIONS[e.code];
        if (action) this.pressed.add(action);
        if (e.code === 'ArrowUp') this.pressed.add('arrowUp');
        if (e.code === 'ArrowDown') this.pressed.add('arrowDown');
        if (e.code === 'ArrowLeft') this.pressed.add('arrowLeft');
        if (e.code === 'ArrowRight') this.pressed.add('arrowRight');
        if (e.code === 'Escape') this.pressed.add('back');
        if (/^Digit[1-9]$/.test(e.code)) this.pressed.add(`overlay${Number(e.code.slice(5))}`);
      }
      this.down.add(e.code);
      this.usingGamepad = false;
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());

    canvas.addEventListener('click', () => {
      if (document.pointerLockElement !== canvas) canvas.requestPointerLock?.();
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas) return;
      if (Math.abs(e.movementX) > MOUSE_SPIKE || Math.abs(e.movementY) > MOUSE_SPIKE) return;
      this.mouseX += e.movementX;
      this.mouseY += e.movementY;
      this.usingGamepad = false;
    });
    canvas.addEventListener('wheel', (e) => {
      this.wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });

    // Pads are also found by polling every frame (see readPad), so a controller that was
    // connected before the page loaded is picked up as soon as it is touched.
    window.addEventListener('gamepaddisconnected', (e) => {
      this.pads.delete(e.gamepad.index);
      if (e.gamepad.index === this.activePad) {
        this.activePad = null;
        this.lastPad = null;
        this.onGamepadChange(null);
      }
    });
  }

  /** One-line description of controller support, for the help and pause screens. */
  controllerStatus(): string {
    if (!window.isSecureContext) {
      return `Controllers need a secure page: open the game on http://localhost, not ${location.host}`;
    }
    if (!navigator.getGamepads) return 'This browser does not expose controllers (Gamepad API missing)';
    if (this.lastPad) return `Controller: ${this.lastPad.id}${this.lastPad.layout === 'standard' ? '' : ' (unmapped layout)'}`;
    return 'No controller yet: press any button on it while this tab is focused';
  }

  private readPad(): LogicalPad | null {
    const list = navigator.getGamepads ? Array.from(navigator.getGamepads()) : [];
    for (const p of list) {
      if (!p || !p.connected) continue;
      let st = this.pads.get(p.index);
      if (!st || st.id !== p.id) {
        st = {
          id: p.id,
          layout: p.mapping === 'standard' ? 'standard' : 'xinput',
          armed: p.axes.map(() => false),
          prev: [],
          held: [],
        };
        this.pads.set(p.index, st);
      }
      const logical = this.mapPad(p, st);
      const newPress = logical.buttons.some((down, i) => down && !st.held[i]);
      st.held = logical.buttons.slice();
      const moved = [logical.lx, logical.ly, logical.rx, logical.ry, logical.lt, logical.rt].some((v) => Math.abs(v) > 0.5);
      // Whichever pad was last picked up is the one we read, so a stray device can't hold the slot.
      if ((newPress || moved) && this.activePad !== p.index) {
        this.activePad = p.index;
        this.onGamepadChange(p.id);
      }
    }
    if (this.activePad === null || !list[this.activePad]) return null;
    const pad = list[this.activePad]!;
    const st = this.pads.get(pad.index)!;
    const logical = this.mapPad(pad, st);
    this.lastPad = {
      id: pad.id,
      layout: st.layout,
      axes: pad.axes,
      pressed: pad.buttons.flatMap((b, i) => (b.pressed ? [i] : [])),
    };
    return logical;
  }

  private mapPad(p: Gamepad, st: PadState): LogicalPad {
    const axis = (i: number) => {
      const v = p.axes[i] ?? 0;
      if (!st.armed[i] && Math.abs(v) < 0.2) st.armed[i] = true;
      return st.armed[i] ? v : 0;
    };
    // Trigger axes rest at -1; they count once seen there.
    const triggerAxis = (i: number) => {
      const v = p.axes[i] ?? -1;
      if (!st.armed[i] && v < -0.8) st.armed[i] = true;
      return st.armed[i] ? (v + 1) / 2 : 0;
    };
    const raw = (i: number) => p.buttons[i]?.pressed ?? false;

    if (st.layout === 'standard') {
      return {
        lx: axis(0), ly: axis(1), rx: axis(2), ry: axis(3),
        lt: p.buttons[PAD.LT]?.value ?? 0,
        rt: p.buttons[PAD.RT]?.value ?? 0,
        buttons: Array.from({ length: 16 }, (_, i) => raw(i)),
      };
    }

    // Unmapped Xbox layout: A B X Y LB RB View Menu Guide L3 R3; d-pad on axes 6 and 7.
    const dx = p.axes.length > 7 ? axis(6) : 0;
    const dy = p.axes.length > 7 ? axis(7) : 0;
    const buttons: boolean[] = [];
    buttons[PAD.A] = raw(0);
    buttons[PAD.B] = raw(1);
    buttons[PAD.X] = raw(2);
    buttons[PAD.Y] = raw(3);
    buttons[PAD.LB] = raw(4);
    buttons[PAD.RB] = raw(5);
    buttons[PAD.VIEW] = raw(6);
    buttons[PAD.MENU] = raw(7);
    buttons[PAD.L3] = raw(9);
    buttons[PAD.R3] = raw(10);
    buttons[PAD.UP] = dy < -0.5;
    buttons[PAD.DOWN] = dy > 0.5;
    buttons[PAD.LEFT] = dx < -0.5;
    buttons[PAD.RIGHT] = dx > 0.5;
    const lt = triggerAxis(2);
    const rt = triggerAxis(5);
    buttons[PAD.LT] = lt > 0.5;
    buttons[PAD.RT] = rt > 0.5;
    return { lx: axis(0), ly: axis(1), rx: axis(3), ry: axis(4), lt, rt, buttons };
  }

  releasePointer(): void {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  private key(...codes: string[]): number {
    return codes.some((c) => this.down.has(c)) ? 1 : 0;
  }

  poll(): FrameInput {
    const actions = this.pressed;
    this.pressed = new Set();

    let collective = this.key('KeyW', 'ShiftLeft') - this.key('KeyS', 'ControlLeft');
    let yaw = this.key('KeyD') - this.key('KeyA');
    let pitch = this.key('ArrowUp', 'Numpad8') - this.key('ArrowDown', 'Numpad5', 'Numpad2');
    let roll = this.key('ArrowRight', 'Numpad6') - this.key('ArrowLeft', 'Numpad4');
    let lookX = 0;
    let lookY = 0;

    const pad = this.readPad();
    if (pad) {
      const b = (i: number) => pad.buttons[i] ?? false;
      const [lx, ly] = stick(pad.lx, pad.ly);
      const [rx, ry] = stick(pad.rx, pad.ry);
      const padCollective = trigger(pad.rt) - trigger(pad.lt);
      const padYaw = (b(PAD.RB) ? 1 : 0) - (b(PAD.LB) ? 1 : 0);

      const active = lx || ly || rx || ry || padCollective || padYaw;
      if (active) this.usingGamepad = true;

      collective += padCollective;
      yaw += padYaw;
      roll += lx;
      pitch += -ly;
      lookX = rx;
      lookY = ry;

      const prev = this.pads.get(this.activePad!)!.prev;
      PAD_ACTIONS.forEach(([button, action]) => {
        const now = b(button);
        if (now && !prev[button]) {
          actions.add(action);
          this.usingGamepad = true;
        }
        prev[button] = now;
      });
    }

    const clamp1 = (n: number) => Math.max(-1, Math.min(1, n));
    const frame: FrameInput = {
      collective: clamp1(collective),
      yaw: clamp1(yaw),
      pitch: clamp1(pitch),
      roll: clamp1(roll),
      lookX,
      lookY,
      mouseX: this.mouseX,
      mouseY: this.mouseY,
      zoom: this.wheel,
      actions,
      usingGamepad: this.usingGamepad,
    };
    this.mouseX = 0;
    this.mouseY = 0;
    this.wheel = 0;
    return frame;
  }
}
