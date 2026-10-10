import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';

/** The main process owns both the sender identity and the current native frame. */
export function isCurrentUiFrame(
  event: IpcMainEvent | IpcMainInvokeEvent,
  contents: WebContents,
): boolean {
  try {
    const frame = event.senderFrame;
    return (
      !contents.isDestroyed() &&
      event.sender === contents &&
      frame !== null &&
      frame === contents.mainFrame &&
      !frame.isDestroyed() &&
      // Electron 43.7.7 can retain detached=true after replacing a crashed RFH.
      // Event IDs identify the sending RFH independently of the reused wrapper.
      Number.isSafeInteger(event.processId) &&
      event.processId >= 0 &&
      Number.isSafeInteger(event.frameId) &&
      event.frameId >= 0 &&
      event.processId === frame.processId &&
      event.frameId === frame.routingId
    );
  } catch {
    return false;
  }
}
