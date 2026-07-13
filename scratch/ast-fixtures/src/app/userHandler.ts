import { UserService } from '../services/UserService';

export function handleCreate(name: string): string {
  const svc = new UserService();
  return svc.createUser(name);
}
