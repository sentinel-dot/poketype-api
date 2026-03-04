import { Router } from 'express';
import { getMatchup } from '../controllers/matchup';
import { searchPokemon } from '../controllers/search';

const router = Router();

// GET /pokemon/search?q=charmander
router.get('/search', searchPokemon);

// GET /pokemon/:name/matchup?gen=1
router.get('/:name/matchup', getMatchup);

export default router;
