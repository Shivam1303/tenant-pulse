import { ConfirmProvider } from "../../components/ui";
import { LiveProvider } from "../../components/live-provider";
import { WorkspaceProvider } from "../../components/workspace-provider";
import { WorkspaceShell } from "../../components/workspace-shell";
import type { ReactNode } from "react";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <ConfirmProvider>
      <WorkspaceProvider>
        <LiveProvider>
          <WorkspaceShell>{children}</WorkspaceShell>
        </LiveProvider>
      </WorkspaceProvider>
    </ConfirmProvider>
  );
}
