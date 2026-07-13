export class OrderService {
  status(id: number): string {
    return id > 0 ? 'ok' : 'missing';
  }
}
