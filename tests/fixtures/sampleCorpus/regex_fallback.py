# Non-JS/TS language — indexed via regex identifier matching only (no spans/edges/editing).
def compute_total(items):
    return sum(items)


class OrderService:
    def place_order(self, order):
        return compute_total(order.items)
