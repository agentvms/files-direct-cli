/** Every sentence of the saved-devices screens (docs/WORDING.md). Loaded with the room, or with the saved-devices screen, not with the page's first script. */
import { SAVED_DEVICES_MAX } from '../../shared/pair.ts';
import { ASK_WAIT_MS, type RememberProblem, type RememberSaid } from './remember.ts';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** How long a question to the other device waits, in plain words. */
const ASK_SECONDS = Math.round(ASK_WAIT_MS / 1000);

export const SAVED = {
  // The page's own words (files-direct-58, fd-e3z): on every one of them "this device" is the device in the person's hand, and the other one is "the other device". The program's window keeps the
  // sentences below that name the older keys (remember, rememberHint, nameLabel, nameHelp, waiting, asked, saved): its flows did not change.
  rememberOther: 'Remember the other device',
  rememberOtherHint: 'Next time you can send between these two with no link or code. Both of you need Files Direct open.',
  otherLabel: 'What do you want to call the other device?',
  otherHelp: 'This name is only kept here. The other device never sees it, and neither do we. To change the name of this device, open Saved devices in the menu.',
  askingTitle: 'Asking the other device',
  asking: 'It now shows a question with "Remember" and "No thanks". Nothing is saved unless it says Remember. If nobody answers, this stops by itself after ' + ASK_SECONDS + ' seconds.',
  savingTitle: 'Saving',
  saving: 'Almost done. Finishing with the other device.',
  askedHere: (label: string, name: string) => capital(label) + ' called ' + name + ' asks you to remember it, so the two of you can send files with no link or code. Nothing is saved unless you press Remember.',
  savedHere: (name: string) =>
    name + ' is remembered. Next time both of you have Files Direct open, you will see "Send to ' + name + '" on the home page, with no link or code. To forget it, open Saved devices in the menu.',
  said: (what: RememberSaid): string => (what === 'cancelled' ? 'Nothing was saved.' : 'The other device stopped asking. Nothing was saved.'),
  thisDevice: 'This device',
  otherDevices: 'Remembered devices',
  remember: 'Remember this device',
  rememberHint: 'Next time you are both here, you can send between these two with no link or code.',
  rememberTitle: (name: string) => 'Remember ' + name,
  nameLabel: 'What do you want to call it?',
  nameHelp: 'Only this device keeps this name. The other device never sees it, and neither do we.',
  ok: 'Remember',
  tryAgain: 'Try again',
  cancel: 'Cancel',
  noThanks: 'No thanks',
  waiting: 'Waiting for the other device to say yes.',
  asked: (label: string, name: string) => capital(label) + ' called ' + name + ' wants to remember this device, so the two of you can send files with no link or code.',
  savedTitle: 'Remembered',
  saved: (name: string) => 'When ' + name + ' has Files Direct open, you will see "Send to ' + name + '" on the home page, with no link or code. To forget it, open Saved devices in the menu.',
  problem: (why: RememberProblem): string =>
    ({
      declined: 'The other device said no thanks. Nothing was saved.',
      failed: 'That did not work, so nothing was saved. You can try again.',
      full: 'One of you already remembers ' + SAVED_DEVICES_MAX + ' devices. Forget one under Saved devices in the menu, then try again.',
      busy: 'You both asked at once. Press Remember on just one of them.',
      'timed-out': 'No answer, so nothing was saved.',
      'not-saved': 'This browser would not keep it, so nothing was saved. Private browsing can cause this.',
    })[why],
  sendTo: (name: string) => 'Send to ' + name,
  notHere: (name: string) => name + ' closed the page. Open it there and try again.',
  waitingTitle: (name: string) => 'Sending to ' + name,
  waitingHelp: 'The files go as soon as it answers. It still asks before it takes them.',
  noAnswer: (name: string) => name + ' has not answered yet. If it is in the middle of something else, finish or close that there. The files go as soon as it can take them.',
  cancelWaiting: 'Cancel',
  panelTitle: 'Saved devices',
  panelIntro: 'Devices you chose to remember. When both of you have Files Direct open, they show up on the home page.',
  nameIntro: 'Give this device a name. Whoever you connect to sees it, so they know which device is sending.',
  nameHint: 'Stays in this browser. We never see it. Leave it empty and the other device sees the kind of device, like a Mac.',
  selfLabel: 'Name of this device',
  selfSave: 'Save name',
  selfSaved: (others: boolean) => (others ? 'Name saved. The devices you remembered see it the next time you connect, unless they call this one something else.' : 'Name saved. Whoever you connect to sees it.'),
  selfCleared: 'Name removed. The other device sees the kind of device instead.',
  none: 'No saved devices.',
  forget: 'Forget',
  forgetLabel: (name: string) => 'Forget ' + name,
  forgotten: (name: string) => name + ' is forgotten, here and on that device.',
  forgotUnsure: (name: string) => name + ' is forgotten here. We could not reach our servers, so that device may still list this one.',
  clearing: "Clearing this browser's data forgets its saved devices. Forgetting a device here also forgets this one there.",
  dropped: (name: string) => name + ' forgot this device, so it is no longer saved here.',
  close: 'Close',
} as const;
