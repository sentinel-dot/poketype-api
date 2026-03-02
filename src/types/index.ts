export interface MatchupResponse {
  pokemon:     string;
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
