import { Router } from 'express';
import { getMatchup } from '../controllers/matchup';

const router = Router();

// GET /pokemon/:name/matchup?gen=1
router.get('/:name/matchup', getMatchup);

export default router;
