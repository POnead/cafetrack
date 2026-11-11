import type { Viewport } from "next";

export const viewport: Viewport = {
  interactiveWidget: "resizes-content",
};

export default function LoginLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
