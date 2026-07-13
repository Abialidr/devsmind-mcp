export class UserService {
  createUser(name: string): string {
    return `created ${name}`;
  }

  deleteUser(id: number): boolean {
    return id > 0;
  }
}
