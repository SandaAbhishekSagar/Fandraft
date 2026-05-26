"use client";

import React, { useState, useEffect } from "react";

declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

interface LineupPlayer {
  playerId: number;
  name: string;
  team: string;
  position: string;
  slot: string;
  salary: number;
  projectedFP: number;
  value: string;
  reasoning?: string;
}

interface LineupResult {
  lineup: LineupPlayer[];
  totalSalary: number;
  totalProjectedFP: number;
  summary: string;
}

function formatCurrency(amount: number): string {
  return `$${amount.toLocaleString()}`;
}

function PlayerCard({ player }: { player: LineupPlayer }) {
  const [imgError, setImgError] = useState(false);
  const headshotUrl = `https://cdn.nba.com/headshots/nba/latest/1040x760/${player.playerId}.png`;

  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 hover:border-zinc-700 transition-colors">
      <div className="relative mb-3">
        <span className="absolute top-0 left-0 text-xs font-semibold uppercase tracking-wide text-zinc-500">
          {player.slot}
        </span>
        <div className="w-full aspect-square flex items-center justify-center overflow-hidden rounded-lg bg-zinc-800">
          {!imgError ? (
            <img
              src={headshotUrl}
              alt={player.name}
              className="w-full h-full object-cover"
              onError={() => setImgError(true)}
            />
          ) : (
            <div className="w-full h-full bg-zinc-800 flex items-center justify-center text-zinc-600 text-4xl">
              {player.name.charAt(0)}
            </div>
          )}
        </div>
      </div>
      <h3 className="font-bold text-zinc-100 mb-1">{player.name}</h3>
      <p className="text-sm text-zinc-500 mb-2">{player.team}</p>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-zinc-300">
          {formatCurrency(player.salary)}
        </span>
        <span className="text-sm font-semibold text-blue-400">
          {player.projectedFP.toFixed(1)} FP
        </span>
      </div>
      {player.reasoning && (
        <p className="text-xs text-zinc-500 leading-relaxed line-clamp-2">
          {player.reasoning}
        </p>
      )}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 animate-pulse">
      <div className="relative mb-3">
        <div className="w-8 h-4 bg-zinc-800 rounded mb-2"></div>
        <div className="w-full aspect-square bg-zinc-800 rounded-lg"></div>
      </div>
      <div className="h-5 bg-zinc-800 rounded mb-2 w-3/4"></div>
      <div className="h-4 bg-zinc-800 rounded mb-3 w-1/2"></div>
      <div className="flex items-center justify-between mb-2">
        <div className="h-4 bg-zinc-800 rounded w-16"></div>
        <div className="h-4 bg-zinc-800 rounded w-12"></div>
      </div>
      <div className="h-3 bg-zinc-800 rounded mb-1"></div>
      <div className="h-3 bg-zinc-800 rounded w-5/6"></div>
    </div>
  );
}

export default function LineupBuilder() {
  const [request, setRequest] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LineupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isListening, setIsListening] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);

  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    setSpeechSupported(!!SpeechRecognition);
  }, []);

  const handleBuildLineup = async () => {
    if (!request.trim()) {
      setError("Please enter a request");
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await fetch("/api/build-lineup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to build lineup");
      }

      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleBuildLineup();
    }
  };

  const handleVoiceInput = () => {
    if (!speechSupported || isListening) return;

    try {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();

      recognition.continuous = false;
      recognition.lang = "en-US";
      recognition.interimResults = false;

      recognition.onstart = () => {
        setIsListening(true);
        setError(null);
      };

      recognition.onresult = (event: any) => {
        const transcript = event.results[0][0].transcript;
        setRequest(transcript);
        setIsListening(false);
        
        setTimeout(() => {
          handleBuildLineup();
        }, 100);
      };

      recognition.onerror = (event: any) => {
        console.warn("Speech recognition error:", event.error);
        setIsListening(false);
        
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          setError("Microphone access denied. Please allow microphone permissions.");
        } else if (event.error === "network") {
          setError("Voice input unavailable. Try typing instead or check microphone permissions.");
        } else {
          setError("Voice input failed. Please try typing your request.");
        }
      };

      recognition.onend = () => {
        setIsListening(false);
      };

      recognition.start();
    } catch (err) {
      console.error("Failed to initialize speech recognition:", err);
      setError("Voice input unavailable in this browser. Please type your request.");
      setSpeechSupported(false);
    }
  };

  const handleSpeakSummary = () => {
    if (!result || !window.speechSynthesis) return;

    const salaryInThousands = Math.round(result.totalSalary / 1000);
    const projectedPoints = result.totalProjectedFP.toFixed(1);

    const text = `${result.summary} Total salary used, ${salaryInThousands} thousand. Projected ceiling, ${projectedPoints} points.`;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  };

  return (
    <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
      <div className="text-center mb-12">
        <h1 className="text-6xl font-bold mb-4" style={{ color: "#3b82f6" }}>
          FanDraft
        </h1>
        <p className="text-2xl text-zinc-400 mb-4">
          AI-coached fantasy lineup builder
        </p>
        <div className="flex items-center justify-center gap-2 mb-4">
          <span className="px-3 py-1 bg-blue-600/20 text-blue-300 text-xs rounded-full">
            Fan Experience
          </span>
          <span className="px-3 py-1 bg-zinc-800 text-zinc-300 text-xs rounded-full">
            One User: casual DFS player
          </span>
          <span className="px-3 py-1 bg-zinc-800 text-zinc-300 text-xs rounded-full">
            One Problem: 45-min pre-tipoff grind
          </span>
        </div>
        <div className="inline-flex items-center gap-2 px-3 py-1 bg-zinc-900 border border-zinc-800 rounded-full text-sm text-zinc-400">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
          Tonight · SAS @ OKC · WCF Game 5 · Tied 2-2
        </div>
      </div>

      <div className="mb-8">
        <div className="flex gap-2">
          <input
            type="text"
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Ask FanDraft to build you a lineup..."
            className="flex-1 px-4 py-3 bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-zinc-700"
            disabled={loading}
          />
          <button
            onClick={handleBuildLineup}
            disabled={loading}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-800 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors"
          >
            {loading ? "Building..." : "Build Lineup"}
          </button>
          {speechSupported && (
            <button
              onClick={handleVoiceInput}
              disabled={loading || isListening}
              className="relative px-4 py-3 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors text-xl"
            >
              {isListening && (
                <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full animate-pulse"></span>
              )}
              🎤
            </button>
          )}
        </div>
        {error && (
          <p className="mt-2 text-sm text-red-400">{error}</p>
        )}
      </div>

      {loading && (
        <div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {Array.from({ length: 8 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        </div>
      )}

      {result && !loading && (
        <div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {result.lineup.map((player) => (
              <PlayerCard key={player.playerId} player={player} />
            ))}
          </div>

          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
              <div className="flex items-center gap-8">
                <div>
                  <p className="text-sm text-zinc-500 mb-1">Total Salary</p>
                  <p className="text-2xl font-bold text-zinc-100">
                    {formatCurrency(result.totalSalary)}
                    <span className="text-sm text-zinc-500 ml-2">/ $50,000</span>
                  </p>
                </div>
                <div>
                  <p className="text-sm text-zinc-500 mb-1">Projected FP</p>
                  <p className="text-2xl font-bold text-blue-400">
                    {result.totalProjectedFP.toFixed(1)}
                  </p>
                </div>
              </div>
              <div className="flex-1 md:ml-8">
                <p className="text-sm text-zinc-400 italic">{result.summary}</p>
              </div>
            </div>
          </div>

          {window.speechSynthesis && (
            <div className="mt-4 text-center">
              <button
                onClick={handleSpeakSummary}
                className="px-4 py-2 bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-sm rounded-lg transition-colors"
              >
                🔊 Speak summary
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
