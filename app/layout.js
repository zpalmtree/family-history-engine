import "./viewer.css";
import branding from "../lib/viewer-branding.js";

export const metadata = {
  title: branding.title,
  robots: { index: false, follow: false, nocache: true }
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
