import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const title = "六合智研｜港澳开奖与 AI 多维分析";
  const description = "从开奖号码到可解释结论：实时开奖、历史统计、六维研判与滚动回测。";

  return {
    metadataBase: new URL(origin),
    title: { default: title, template: "%s｜六合智研" },
    description:
      "香港六合彩、澳门六合彩当期开奖、历史记录、系统统计、滚动回测与 AI 多维研究。北京时间口径。",
    keywords: ["香港六合彩", "澳门六合彩", "开奖记录", "历史统计", "AI分析"],
    openGraph: {
      title,
      description,
      type: "website",
      locale: "zh_CN",
      images: [{ url: `${origin}/og.png`, width: 1200, height: 630, alt: "六合智研港澳开奖与 AI 多维研判" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [`${origin}/og.png`],
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
