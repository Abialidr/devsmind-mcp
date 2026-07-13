import { UserService } from '../services/UserService';

// References the class itself but calls none of its methods. Must NOT link to
// createUser / deleteUser (guards against over-linking on class import alone).
export function auditService(): typeof UserService {
  return UserService;
}
