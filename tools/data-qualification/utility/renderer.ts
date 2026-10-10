// The renderer receives only this qualification-specific bridge.
const page = globalThis as unknown as {
  qualification: {
    ping(sequence: number): Promise<number>;
    sample(sequence: number, milliseconds: number): Promise<void>;
    environment(nodeVisible: boolean): Promise<void>;
  };
  document: { getElementById(id: string): { textContent: string | null } | null };
};
let sequence = 0;
async function sample(): Promise<void> {
  const current = ++sequence;
  const start = performance.now();
  const returned = await page.qualification.ping(current);
  if (returned !== current) throw new Error('资格UI往返序号错误');
  await page.qualification.sample(current, performance.now() - start);
  const status = page.document.getElementById('status');
  if (status !== null) status.textContent = `真实沙箱UI往返样本：${current}`;
  setTimeout(() => {
    void sample();
  }, 50);
}
void page.qualification
  .environment('require' in globalThis || 'process' in globalThis)
  .then(sample);
