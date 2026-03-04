export interface EvoNode {
  id:        number;
  name:      string;   // display name (DE if available)
  nameEN:    string;   // for API lookups
  evolvesTo: { method: string; node: EvoNode }[];
}

export interface EvolutionResponse {
  chain: EvoNode;
}

export interface MatchupResponse {
  pokemon:     string;
  pokemonId:   number;  // For frontend image URL: official-artwork/{pokemonId}.png
  generation:  number;
  types:       string[];
  matchup: {
    '0':    string[];   // immune
    '0.25': string[];
    '0.5':  string[];
    '1':    string[];
    '2':    string[];
    '4':    string[];
  };
}
