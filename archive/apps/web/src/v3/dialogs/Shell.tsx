import { Modal } from "@heroui/react";
import type { ReactNode } from "react";
import { useDemo } from "../store";

export function Shell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { close } = useDemo();
  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      variant="blur"
    >
      <Modal.Container size="lg" placement="center" scroll="inside">
        <Modal.Dialog className="demo-modal rounded-2xl">
          <Modal.CloseTrigger aria-label="关闭弹窗" />
          <Modal.Header className="border-b border-border px-6 py-5">
            <Modal.Heading className="pr-7 text-xl">{title}</Modal.Heading>
            <p className="mt-1 text-xs leading-6 text-muted">{description}</p>
          </Modal.Header>
          <Modal.Body className="space-y-5 px-6 py-5">{children}</Modal.Body>
          {footer && (
            <Modal.Footer className="flex flex-wrap justify-end gap-2 border-t border-border bg-[#fafbf7] px-6 py-4">
              {footer}
            </Modal.Footer>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
export function ErrorText({ value }: { value: string }) {
  return value ? (
    <p
      role="alert"
      className="rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs leading-6 text-red-700"
    >
      {value}
    </p>
  ) : null;
}
export const errorMessage = (e: unknown) =>
  e instanceof Error ? e.message : "保存失败，请检查输入。";
