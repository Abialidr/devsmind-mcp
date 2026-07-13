import FatController from '../services/FatController';

const router = { get(_p: string, _h: unknown) {} };

// Two adjacent routes into the SAME controller. Each route node must link only to the
// method IT registers, not to every method (or every symbol) in the controller file.
router.get('/things', FatController.listThings);
router.get('/things/remove', FatController.removeThing);

export default router;
