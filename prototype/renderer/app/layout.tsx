import type { Metadata, Viewport } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "AI Council · 智能议会",
  description: "运行一组 AI 成员进行协作讨论或独立作答，并产出可复查的结论。",
  generator: "v0.app",
}

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#1a1f26",
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN" className="bg-background">
      <body className="bg-background font-sans antialiased">{children}</body>
    </html>
  )
}
