import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#090b0c",
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "六合智研｜高概率策略与逐期学习";
  const description = "香港与新澳门开奖数据、高概率分类事件预测和逐期学习复盘：每期固定五项，公开近30期依据、赔率价值与产品学习状态。";

  return {
    metadataBase: new URL(origin),
    title: { default: title, template: "%s｜六合智研" },
    description:
      "香港六合彩与新澳门六合彩当期开奖、历史记录、高概率事件研究、概率校准和逐期产品学习。北京时间口径。",
    keywords: ["香港六合彩", "新澳门六合彩", "开奖记录", "高概率策略", "产品学习", "概率校准"],
    openGraph: {
      title,
      description,
      type: "website",
      locale: "zh_CN",
      images: [{ url: `${origin}/og-v4.png`, width: 1200, height: 630, alt: "六合智研固定五项与产品学习" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og-v4.png`],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
