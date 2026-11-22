"use client";
import { useEffect, useState } from "react";
import { Icon } from "./icons";

const ads = [
  ["kopje", "Kopje Tyre Co.", "Take the long route. Long-haul tyres."],
  ["baobab", "Baobab Tyres", "Go beyond the tarmac. Mixed-surface tyres."],
  ["riftline", "Riftline Tyres", "Ready for the rain. Wet-road tyres."],
  ["savanna", "Savanna Treadworks", "Start the next shift. Commercial fleet tyres."],
  ["summitspan", "Summitspan Tyres", "Head for higher ground. All-terrain tyres."],
];
export default function AdSlot() {
  const [index, setIndex] = useState(0);
  const [play, setPlay] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPlay(!preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!play) return;
    const timer = window.setTimeout(() => setIndex((index + 1) % ads.length), 8000);
    return () => window.clearTimeout(timer);
  }, [play, index]);
  const [slug, brand, message] = ads[index];
  return <section className="panel advert-slot" aria-label="Tyre advertising">
    <div className="panel-heading"><h2>Advert slot</h2><span className="sample-tag">Sample campaign</span></div>
    <img src={`/adverts/${slug}.${play ? "gif" : "jpg"}`} width={840} height={350} alt={`${brand} — ${message}`} />
    <div className="ad-controls"><div className="ad-dots">{ads.map(([key, label], i) =>
      <button key={key} type="button" aria-label={`Show ${label} advert`} aria-pressed={index === i}
        onClick={() => setIndex(i)}><span /></button>)}</div>
      <button className="ad-play" aria-label={play ? "Pause adverts" : "Play adverts"} onClick={() => setPlay(!play)}><Icon name={play ? "pause" : "play"} size={15} /></button>
    </div></section>;
}
