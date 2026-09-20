import type {
  QualificationFrame,
  QualificationNativeBridge,
  QualificationPayloads,
  QualificationRuntimeCapability,
  QualificationWriteReceipt,
} from './native-contract';

/** Synchronous sequence assignment precedes native's bounded, ordered writer queue. */
export class QualificationSequencer {
  private sequence = 0;
  private lastWrite: Promise<QualificationWriteReceipt> | null = null;
  private completed = false;

  constructor(
    private readonly native: QualificationNativeBridge,
    private readonly capability: QualificationRuntimeCapability,
    private readonly qualificationRunId: string,
    private readonly fail: (code: string) => never,
  ) {}

  get prefix(): number {
    return this.sequence;
  }

  send<K extends keyof QualificationPayloads>(
    kind: K,
    payload: QualificationPayloads[K],
    slotIndex: number | null = null,
  ): Promise<QualificationWriteReceipt> {
    if (this.completed || !Number.isSafeInteger(this.sequence + 1)) this.fail('telemetry-state');
    const sequence = ++this.sequence;
    // The native boundary independently validates the closed discriminated DTO.
    const frame = {
      kind,
      payload,
      qualificationRunId: this.qualificationRunId,
      sequence,
      slotIndex,
      version: 2,
    } as QualificationFrame;
    const write = this.native.writeTelemetryFrame(this.capability, frame);
    this.lastWrite = write;
    void write.catch(() => this.fail('telemetry-write'));
    if (kind === 'complete') this.completed = true;
    return write;
  }

  async flush(): Promise<void> {
    await this.lastWrite;
  }
}
