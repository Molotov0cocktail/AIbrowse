// 永久删除二次确认对话框（B5，决议 #73）：prepare-hard-delete 已签发一次性、
// source 绑定、300s 有效的 opaque 令牌；本对话框展示「不可撤销且不能 Undo」的
// 明确文案；确认后 hard-delete 才消费令牌。取消/过期/错绑定/重放/并发双击均零
// 删除（主进程令牌消费即失效）；确认按钮一次提交即禁用（双击受控）。
// 名称以 React 纯文本渲染（决议 #78）。
interface HardDeleteDialogProps {
  sourceName: string;
  pending: boolean;
  onCancel(): void;
  onConfirm(): void;
}

export function HardDeleteDialog({
  sourceName,
  pending,
  onCancel,
  onConfirm,
}: HardDeleteDialogProps) {
  return (
    <div className="sources-hard-delete-dialog" role="dialog" aria-label="永久删除确认">
      <div className="sources-hard-delete-text">确定永久删除「{sourceName}」？</div>
      <div className="sources-hard-delete-warning">
        此操作不可撤销，且不能通过「撤销」恢复。该信源的备注、标签、使用记录将被一并删除。
      </div>
      <div className="sources-hard-delete-actions">
        <button
          type="button"
          className="sources-hard-delete-cancel"
          disabled={pending}
          onClick={onCancel}
        >
          取消
        </button>
        <button
          type="button"
          className="sources-hard-delete-confirm"
          disabled={pending}
          onClick={onConfirm}
        >
          确认永久删除
        </button>
      </div>
    </div>
  );
}
