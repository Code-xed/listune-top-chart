import { NextResponse } from 'next/server';

import { scrapeKworbGlobalDailyTracks } from '@/lib/scraping/kworbTracks';
import { scrapeKworbCountryDailyTracks } from '@/lib/scraping/kworbCountry';
import { resolveTrackOEmbed } from '@/lib/spotify/metadata';
import { SUPPORTED_COUNTRIES } from '@/lib/scraping/kworbCountry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);

    const country = (
      searchParams.get('country') || 'global'
    ).toLowerCase();

    const requestedLimit = Number.parseInt(
      searchParams.get('limit') || '25',
      10
    );

    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 200))
      : 25;

    if (!SUPPORTED_COUNTRIES[country]) {
      return NextResponse.json(
        {
          error: 'Unsupported country',
          supportedCountries: Object.keys(SUPPORTED_COUNTRIES),
        },
        { status: 400 }
      );
    }

    // Fetch directly from Kworb. No database.
    const rawTracks =
      country === 'global'
        ? await scrapeKworbGlobalDailyTracks()
        : await scrapeKworbCountryDailyTracks(country);

    const selectedTracks = rawTracks.slice(0, limit);

    // Resolve album artwork only when Kworb provides a Spotify track ID.
    const tracks = await Promise.all(
      selectedTracks.map(async (track) => {
        let imageUrl: string | undefined;
        let spotifyUrl =
          track.spotifyUrl ||
          (track.trackId
            ? `https://open.spotify.com/track/${track.trackId}`
            : undefined);

        if (track.trackId) {
          try {
            const metadata = await resolveTrackOEmbed(track.trackId);

            if (metadata) {
              imageUrl = metadata.imageUrl;
              spotifyUrl = metadata.url || spotifyUrl;
            }
          } catch (error) {
            console.warn(
              `Artwork lookup failed for ${track.trackName}:`,
              error
            );
          }
        }

        return {
          trackId: track.trackId ?? null,
          name: track.trackName,
          mainArtistName: track.artistName,
          rank: track.rank,

          // No database means no stored previous ranking.
          previousRank: null,
          rankDelta: null,

          dailyStreams: track.dailyStreams,
          totalStreams: track.totalStreams ?? null,

          imageUrl: imageUrl ?? null,
          previewUrl: null,
          spotifyUrl: spotifyUrl ?? null,
        };
      })
    );

    return NextResponse.json(
      {
        country,
        period: 'daily',
        count: tracks.length,
        lastUpdated: new Date().toISOString(),
        tracks,
      },
      {
        headers: {
          'Cache-Control':
            'public, s-maxage=1800, stale-while-revalidate=3600',
        },
      }
    );
  } catch (error) {
    console.error('Direct Kworb chart request failed:', error);

    return NextResponse.json(
      {
        error: 'Failed to fetch Spotify charts',
        details:
          error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 502 }
    );
  }
}
