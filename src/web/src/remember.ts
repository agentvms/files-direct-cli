/**
 * The two pages agreeing to remember each other (files-direct-39, docs/PROTOCOL.md "Saved devices"). It talks over the connection between the two pages only; nothing here
 * goes through our servers except the pair's slot being made (a check of a forget token) or deleted. The one that offered makes the pair secret and says it over the connection
 * once the other said yes; each side keeps the other's name and the secret in this browser.
 */
import { cleanDeviceName, forgetCheck, forgetTokenFromSecret, generatePairSecret, pairIdFromSecret, PAIR_SECRET_PATTERN, SAVED_DEVICES_MAX } from '../../shared/pair.ts';
import type { PairWire } from './transfer/frames.ts';
import { type Keeper, type SavedDevice, addDevice, readStore, setSelfName } from './devices.ts';

/** Why a try ended without a saved device. */
export type RememberProblem = 'declined' | 'failed' | 'full' | 'busy' | 'timed-out' | 'not-saved';

/** What an idle screen says first: this side cancelled, or the other side stopped asking. Either way nothing was saved. */
export type RememberSaid = 'cancelled' | 'withdrawn';

/** What a person sees; remember-ui.ts draws it, a test records it. */
export interface RememberView {
  /** Nothing is going on: a button that starts it, or nothing at all when it cannot be offered now. `said` is what ended just before: a screen tells the person that nothing was saved. */
  idle(offer: (() => void) | null, said?: RememberSaid): void;
  /**
   * This side asks. The screen is about the OTHER device: `start` is the name that device gave itself, and the person may change it into a nickname that stays on this device.
   * `own` is only for a program that says this device's own name with its yes (`--name`); a screen never passes it.
   */
  form(start: string, ok: (nickname: string, own?: string) => void, cancel: () => void): void;
  /**
   * 'asking': the other side was asked and has not answered; `cancel` stops it (the other side's question goes away). 'saving': this side said yes and the pair is being made, which takes
   * seconds and has no cancel.
   */
  waiting(kind: 'asking' | 'saving', cancel?: () => void): void;
  /** The other side asks: the name it gave itself, the nickname to keep it by (starts as that name), then Remember or No thanks. */
  asked(theirName: string, start: string, ok: (nickname: string, own?: string) => void, no: () => void): void;
  saved(theirName: string): void;
  /** It ended without a saved device. again tries once more (null when it cannot be offered). */
  problem(why: RememberProblem, again: (() => void) | null): void;
}

export interface RememberDeps {
  kv: Keeper;
  view: RememberView;
  send(m: PairWire): void;
  /** A plain guess at this device's name, said to the other device when this one was never named. */
  guess(): string;
  /** The name the other device said it has (or a plain word for its kind of device when it said none), to start the nickname from. */
  announced(): string;
  /** Makes the pair's slot on our side (the check of its forget token); true when it was made. */
  register(id: string, check: string): Promise<boolean>;
  /** Takes the slot away again (a try that did not finish). */
  unregister(id: string, token: string): Promise<void>;
  /** Runs a function later; gives back how to cancel it. */
  after(fn: () => void, ms: number): () => void;
  /** A device was saved on this side. */
  saved(d: SavedDevice): void;
}

export const ASK_WAIT_MS = 90_000;
export const SECRET_WAIT_MS = 20_000;

type Mode = 'idle' | 'form' | 'waiting' | 'asked' | 'accepted' | 'registering' | 'sent';

const FALLBACK = 'Another device';

export class RememberFlow {
  private mode: Mode = 'idle';
  private available = false;
  private theirs = '';
  /** What the person left in the field for the other device. It is kept as the nickname unless it is the very name the device gave itself. Never this device's own name. */
  private typed = '';
  private made: { id: string; token: string; secret: string } | null = null;
  private stop: (() => void) | null = null;
  private ended = false;

  constructor(private readonly d: RememberDeps) {}

  /** A try is under way (a question asked or waiting, a pair being made): the program's run does not end before it settles. */
  get busy(): boolean {
    return !this.ended && this.mode !== 'idle';
  }

  /** Whether remembering may be offered now (connected, the other page can do it, and this room is not itself a saved one). */
  setAvailable(on: boolean): void {
    this.available = on;
    if (this.mode === 'idle') this.showIdle();
  }

  private showIdle(said?: RememberSaid): void {
    this.d.view.idle(this.available ? () => this.begin() : null, said);
  }

  private timer(ms: number, fn: () => void): void {
    this.stop?.();
    this.stop = this.d.after(() => {
      this.stop = null;
      fn();
    }, ms);
  }

  private clear(): void {
    this.stop?.();
    this.stop = null;
  }

  private reset(): void {
    this.clear();
    this.mode = 'idle';
    this.made = null;
    this.typed = '';
  }

  private end(why: RememberProblem): void {
    const made = this.made;
    this.reset();
    if (made) void this.d.unregister(made.id, made.token).catch(() => {});
    this.d.view.problem(why, this.available ? () => this.begin() : null);
  }

  private full(): boolean {
    return readStore(this.d.kv).devices.length >= SAVED_DEVICES_MAX;
  }

  /** This device's own name, as said to the other device: the one it was given, else a plain guess. Reading it writes nothing. */
  private own(say?: string): string {
    const given = cleanDeviceName(say);
    if (given) setSelfName(this.d.kv, given); // only a program's --name: a person's screens never name this device from here
    return given || readStore(this.d.kv).self || this.d.guess();
  }

  /**
   * A saved device as this browser keeps it: shown by the name the person accepted or typed, which is a nickname whenever it is not the very name the device gave itself (files-direct-58,
   * fd-e3z: a plain word for its kind that was accepted, "Linux computer", used to be replaced by the name the device then said, "Chrome on Linux"). Only a name the person left as the
   * device's own keeps following what the device calls itself.
   */
  private device(id: string, secret: string, side: 'a' | 'b'): SavedDevice {
    const nick = this.typed && this.typed !== this.theirs ? this.typed : '';
    return { id, name: nick || this.theirs, secret, side, made: Date.now(), ...(nick ? { nick } : {}) };
  }

  /** The person pressed "Remember this device". */
  private begin(): void {
    if (this.mode !== 'idle' || this.ended) return;
    if (this.full()) return this.d.view.problem('full', null);
    this.mode = 'form';
    const start = cleanDeviceName(this.d.announced()) || FALLBACK;
    this.d.view.form(
      start,
      (name, own) => {
        if (this.mode !== 'form' || this.ended) return;
        const mine = this.own(own);
        this.typed = cleanDeviceName(name);
        this.mode = 'waiting';
        this.d.view.waiting('asking', () => this.stopAsking());
        this.d.send({ t: 'pair', p: 'offer', name: mine });
        this.timer(ASK_WAIT_MS, () => {
          this.d.send({ t: 'pair', p: 'cancel', why: 'timed-out' });
          this.end('timed-out');
        });
      },
      () => {
        this.reset();
        this.showIdle('cancelled');
      },
    );
  }

  /** The person pressed Cancel while the other device is being asked: the other side is told, and nothing was made. */
  private stopAsking(): void {
    if (this.mode !== 'waiting' || this.ended) return;
    this.d.send({ t: 'pair', p: 'cancel', why: 'cancelled' });
    this.reset();
    this.showIdle('cancelled');
  }

  /** A frame from the other page. Anything out of order, or not shaped right, is ignored. */
  async handle(m: PairWire): Promise<void> {
    if (this.ended || !m || m.t !== 'pair') return;
    switch (m.p) {
      case 'offer':
        return this.onOffer(m);
      case 'accept':
        return this.onAccept(m);
      case 'decline':
        if (this.mode === 'waiting') this.end('declined');
        return;
      case 'secret':
        return this.onSecret(m);
      case 'done':
        return this.onDone();
      case 'cancel':
        if (m.why === 'cancelled' && (this.mode === 'asked' || this.mode === 'accepted')) {
          // the other side stopped asking: the question goes away, and the screen says nothing was saved
          this.reset();
          return this.showIdle('withdrawn');
        }
        if (this.mode !== 'idle') this.end(m.why === 'full' ? 'full' : m.why === 'busy' ? 'busy' : m.why === 'timed-out' ? 'timed-out' : 'failed');
        return;
      default:
        return;
    }
  }

  private onOffer(m: PairWire): void {
    if (this.mode !== 'idle' && this.mode !== 'form') {
      // both sides asked at once: neither goes on
      this.d.send({ t: 'pair', p: 'cancel', why: 'busy' });
      return this.end('busy');
    }
    if (this.full()) {
      this.d.send({ t: 'pair', p: 'cancel', why: 'full' });
      this.reset();
      return this.d.view.problem('full', this.available ? () => this.begin() : null);
    }
    this.reset();
    this.mode = 'asked';
    this.theirs = cleanDeviceName(m.name) || FALLBACK;
    this.d.view.asked(
      this.theirs,
      this.theirs,
      (name, own) => {
        if (this.mode !== 'asked' || this.ended) return;
        const mine = this.own(own);
        this.typed = cleanDeviceName(name);
        this.mode = 'accepted';
        this.d.view.waiting('saving');
        this.d.send({ t: 'pair', p: 'accept', name: mine });
        this.timer(SECRET_WAIT_MS, () => {
          this.d.send({ t: 'pair', p: 'cancel', why: 'timed-out' });
          this.end('failed');
        });
      },
      () => {
        this.d.send({ t: 'pair', p: 'decline' });
        this.reset();
        this.showIdle();
      },
    );
  }

  private async onAccept(m: PairWire): Promise<void> {
    if (this.mode !== 'waiting') return;
    this.theirs = cleanDeviceName(m.name) || FALLBACK;
    if (this.full()) {
      this.d.send({ t: 'pair', p: 'cancel', why: 'full' });
      return this.end('full');
    }
    this.clear();
    this.mode = 'registering';
    this.d.view.waiting('saving'); // the same screen the other side has: Cancel is gone, since it could no longer stop anything
    const secret = generatePairSecret();
    const id = await pairIdFromSecret(secret);
    const token = await forgetTokenFromSecret(secret);
    this.made = { id, token, secret };
    let ok: boolean;
    try {
      ok = await this.d.register(id, await forgetCheck(token));
    } catch {
      ok = false;
    }
    if (this.mode !== 'registering') {
      // the other side gave up while this waited: the slot is taken away again
      if (ok) await this.d.unregister(id, token).catch(() => {});
      return;
    }
    if (!ok) {
      this.d.send({ t: 'pair', p: 'cancel', why: 'failed' });
      this.made = null;
      return this.end('failed');
    }
    this.mode = 'sent';
    this.d.send({ t: 'pair', p: 'secret', secret });
    this.timer(SECRET_WAIT_MS, () => {
      this.d.send({ t: 'pair', p: 'cancel', why: 'timed-out' });
      this.end('failed');
    });
  }

  private async onSecret(m: PairWire): Promise<void> {
    if (this.mode !== 'accepted') return;
    if (typeof m.secret !== 'string' || !PAIR_SECRET_PATTERN.test(m.secret)) {
      this.d.send({ t: 'pair', p: 'cancel', why: 'failed' });
      return this.end('failed');
    }
    const id = await pairIdFromSecret(m.secret);
    if (this.mode !== 'accepted') return;
    const dev = this.device(id, m.secret, 'b');
    const kept = addDevice(this.d.kv, dev);
    if (kept !== 'ok') {
      this.d.send({ t: 'pair', p: 'cancel', why: kept === 'full' ? 'full' : 'failed' });
      return this.end(kept === 'full' ? 'full' : 'not-saved');
    }
    this.d.send({ t: 'pair', p: 'done' });
    this.finish(dev);
  }

  private onDone(): void {
    const made = this.made;
    if (this.mode !== 'sent' || !made) return;
    const dev = this.device(made.id, made.secret, 'a');
    const kept = addDevice(this.d.kv, dev);
    if (kept !== 'ok') {
      this.d.send({ t: 'pair', p: 'cancel', why: 'failed' });
      return this.end(kept === 'full' ? 'full' : 'not-saved');
    }
    this.made = null; // kept: the slot stays
    this.finish(dev);
  }

  private finish(dev: SavedDevice): void {
    this.reset();
    this.d.view.saved(dev.name);
    this.d.saved(dev);
  }

  /** The room is over: nothing is left running, and a slot made for a try that did not finish is taken away. */
  dispose(): void {
    this.ended = true;
    this.clear();
    const made = this.made;
    this.made = null;
    if (made && this.mode !== 'idle') void this.d.unregister(made.id, made.token).catch(() => {});
  }
}
