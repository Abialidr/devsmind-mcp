import { UserService } from './user.service';
export class UserController {
  private userService = new UserService();
  getUser(id: string): string {
    return this.userService.getUserName(id);
  }
}
