import { ImageResponse } from "next/og";
import { business, cp12 } from "@/lib/business";

export const alt = `${business.name} — Gas Safety Certificate Wolverhampton ${cp12.priceDisplay}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          backgroundColor: "#0b1b30",
          padding: 80,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 30, color: "#ffab2e", fontWeight: 700 }}>
          GAS SAFE REGISTERED · WOLVERHAMPTON
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 76,
            fontWeight: 800,
            color: "white",
            lineHeight: 1.1,
            marginTop: 28,
          }}
        >
          Gas Safety Certificate Wolverhampton
        </div>
        <div
          style={{
            display: "flex",
            fontSize: 64,
            fontWeight: 800,
            color: "#ffab2e",
            marginTop: 20,
          }}
        >
          Fixed {cp12.priceTotalDisplay}
        </div>
        <div style={{ display: "flex", fontSize: 32, color: "#c2d5ec", marginTop: 32 }}>
          {business.name} · Book online · Pay after completion
        </div>
      </div>
    ),
    size,
  );
}
