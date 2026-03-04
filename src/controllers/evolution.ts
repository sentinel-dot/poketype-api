import { Request, Response } from 'express';
import { RowDataPacket } from 'mysql2';
import pool from '../db/connection';

interface PokemonRow extends RowDataPacket { id: number; identifier: string; }
interface NameRow extends RowDataPacket {
  id: number;
  identifier: string;
  nameDE: string | null;
  nameEN: string | null;
}

const ITEM_NAMES_DE: Record<string, string> = {
  'fire-stone':        'Feuerstein',
  'water-stone':       'Wasserstein',
  'thunder-stone':     'Donnerstein',
  'leaf-stone':        'Blattstein',
  'moon-stone':        'Mondstein',
  'sun-stone':         'Sonnenstein',
  'shiny-stone':       'Glanzstein',
  'dusk-stone':        'Finsterstein',
  'dawn-stone':        'Morgenrötestein',
  'ice-stone':         'Eisstein',
  'kings-rock':        'Königsstein',
  'metal-coat':        'Metallhülle',
  'dragon-scale':      'Drachenschuppe',
  'upgrade':           'Upgrade',
  'dubious-disc':      'Dubiose Disc',
  'oval-stone':        'Ovalstein',
  'protector':         'Protektor',
  'electirizer':       'Elektrisierer',
  'magmarizer':        'Magmarisierer',
  'razor-fang':        'Rasierfang',
  'razor-claw':        'Rasierklaue',
  'reaper-cloth':      'Sensenstoff',
  'deep-sea-tooth':    'Meerestiefzahn',
  'deep-sea-scale':    'Meerestiefschuppe',
  'prism-scale':       'Prismenschuppe',
  'sachet':            'Duftsäckchen',
  'whipped-dream':     'Traumschaum',
  'sweet-apple':       'Süßer Apfel',
  'tart-apple':        'Herber Apfel',
  'cracked-pot':       'Rissiger Topf',
  'chipped-pot':       'Gesprungener Topf',
  'auspicious-armor':  'Glücksrüstung',
  'malicious-armor':   'Üble Rüstung',
  'peat-block':        'Torfblock',
  'black-augurite':    'Schwarzer Augurit',
};

function formatMethod(details: any[]): string {
  if (!details || details.length === 0) return '';
  const d = details[0];
  const trigger = d.trigger?.name;

  if (trigger === 'trade') {
    if (d.held_item) {
      const item = ITEM_NAMES_DE[d.held_item.name] ?? d.held_item.name;
      return `Tausch mit ${item}`;
    }
    return 'Tausch';
  }

  if (trigger === 'use-item') {
    return ITEM_NAMES_DE[d.item?.name] ?? d.item?.name ?? 'Item';
  }

  if (trigger === 'level-up') {
    const parts: string[] = [];
    if (d.min_level)             parts.push(`Level ${d.min_level}`);
    if (d.min_happiness)         parts.push('Hohe Freundschaft');
    if (d.min_beauty)            parts.push('Hohe Schönheit');
    if (d.min_affection)         parts.push('Hohe Zuneigung');
    if (d.time_of_day === 'day')   parts.push('(Tag)');
    if (d.time_of_day === 'night') parts.push('(Nacht)');
    if (d.held_item) {
      const item = ITEM_NAMES_DE[d.held_item.name] ?? d.held_item.name;
      parts.push(`(hält ${item})`);
    }
    if (d.known_move)            parts.push(`(kennt ${d.known_move.name})`);
    if (d.location)              parts.push(`(${d.location.name})`);
    if (d.needs_overworld_rain)  parts.push('(bei Regen)');
    if (d.turn_upside_down)      parts.push('(auf Kopf stellen)');
    return parts.length > 0 ? parts.join(' ') : 'Level Up';
  }

  if (trigger === 'shed')                  return 'Entwicklung (Leer)';
  if (trigger === 'spin')                  return 'Drehen';
  if (trigger === 'three-critical-hits')   return '3 krit. Treffer';
  if (trigger === 'take-damage')           return 'Schaden nehmen';
  if (trigger === 'agile-style-move')      return 'Agiler Stil';
  if (trigger === 'strong-style-move')     return 'Starker Stil';
  if (trigger === 'recoil-damage')         return 'Rückstoßschaden';
  if (trigger === 'other')                 return 'Besondere Bedingung';
  return trigger ?? '';
}

interface EvoNode {
  id: number;
  name: string;
  nameEN: string;
  evolvesTo: { method: string; node: EvoNode }[];
}

function parseChain(
  chainNode: any,
  nameMap: Map<string, { id: number; nameDE: string | null; nameEN: string }>,
): EvoNode {
  const identifier = chainNode.species.name;
  const info = nameMap.get(identifier);

  // Fallback: extract species ID from URL for artwork if not in DB
  const urlParts = (chainNode.species.url as string).split('/');
  const speciesId = parseInt(urlParts[urlParts.length - 2]);

  const id    = info?.id ?? speciesId;
  const name  = info?.nameDE ?? info?.nameEN ?? identifier;
  const nameEN = info?.nameEN ?? identifier;

  const evolvesTo = (chainNode.evolves_to ?? []).map((evo: any) => ({
    method: formatMethod(evo.evolution_details),
    node:   parseChain(evo, nameMap),
  }));

  return { id, name, nameEN, evolvesTo };
}

function collectIdentifiers(chainNode: any, result: string[] = []): string[] {
  result.push(chainNode.species.name);
  for (const evo of (chainNode.evolves_to ?? [])) collectIdentifiers(evo, result);
  return result;
}

export async function getEvolution(req: Request, res: Response): Promise<void> {
  const { name } = req.params;

  // Resolve Pokémon via DB
  const [pokemonRows] = await pool.query<PokemonRow[]>(
    `SELECT p.id, p.identifier
     FROM pokemon p
     JOIN pokemon_names pn ON pn.pokemon_id = p.id
     WHERE LOWER(pn.name) = LOWER(?)
     LIMIT 1`,
    [name],
  );

  if (pokemonRows.length === 0) {
    res.status(404).json({ error: `Pokémon "${name}" nicht gefunden.` });
    return;
  }

  const pokemonId = pokemonRows[0].id;

  // Fetch species → evolution chain URL
  const speciesRes = await fetch(`https://pokeapi.co/api/v2/pokemon-species/${pokemonId}`);
  if (!speciesRes.ok) {
    res.status(502).json({ error: 'Entwicklungsdaten konnten nicht geladen werden.' });
    return;
  }
  const species = await speciesRes.json() as { evolution_chain: { url: string } };

  const chainRes = await fetch(species.evolution_chain.url);
  if (!chainRes.ok) {
    res.status(502).json({ error: 'Entwicklungskette konnte nicht geladen werden.' });
    return;
  }
  const chainData = await chainRes.json() as { chain: any };

  // Batch-fetch all names from DB
  const identifiers = collectIdentifiers(chainData.chain);
  const placeholders = identifiers.map(() => '?').join(',');

  const [nameRows] = await pool.query<NameRow[]>(
    `SELECT p.id, p.identifier,
            MAX(CASE WHEN pn.language = 'de' THEN pn.name END) AS nameDE,
            MAX(CASE WHEN pn.language = 'en' THEN pn.name END) AS nameEN
     FROM pokemon p
     JOIN pokemon_names pn ON pn.pokemon_id = p.id
     WHERE p.identifier IN (${placeholders})
     GROUP BY p.id, p.identifier`,
    identifiers,
  );

  const nameMap = new Map<string, { id: number; nameDE: string | null; nameEN: string }>();
  for (const row of nameRows) {
    nameMap.set(row.identifier, {
      id:     row.id,
      nameDE: row.nameDE,
      nameEN: row.nameEN ?? row.identifier,
    });
  }

  const chain = parseChain(chainData.chain, nameMap);
  res.json({ chain });
}
