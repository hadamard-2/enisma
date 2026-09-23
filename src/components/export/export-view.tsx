import type { ExportStatus } from "@/lib/api";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ExportView({
  status,
  onHide,
}: {
  status: ExportStatus;
  onHide: () => void;
  onDismiss: () => void;
  onExportAgain: (projectId: string) => void;
  onGoToPage: (projectId: string, pageNo: number) => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onHide()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{status.title}</DialogTitle>
        </DialogHeader>
        <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(status, null, 2)}</pre>
      </DialogContent>
    </Dialog>
  );
}
