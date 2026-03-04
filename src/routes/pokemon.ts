import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { getMatchup } from '../controllers/matchup';
import { searchPokemon } from '../controllers/search';
import { getEvolution } from '../controllers/evolution';

const router = Router();

function asyncHandler(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>): RequestHandler {
  return (req, res, next) => fn(req, res, next).catch(next);
}

// GET /pokemon/search?q=charmander
router.get('/search', asyncHandler(searchPokemon));

// GET /pokemon/:name/matchup?gen=1
router.get('/:name/matchup', asyncHandler(getMatchup));

// GET /pokemon/:name/evolution
router.get('/:name/evolution', asyncHandler(getEvolution));

export default router;
