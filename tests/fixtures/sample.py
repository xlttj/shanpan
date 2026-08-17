"""Sample Python fixture for shanpan parser tests."""

MAX_RETRIES = 3
default_timeout = 30  # lower-case: not a constant, must NOT be extracted


def compute_total(items):
    return sum(items)


class Order:
    STATUS_OPEN = "open"

    def __init__(self, customer):
        self.customer = customer

    def total(self):
        return compute_total(self.items())

    @property
    def is_empty(self):
        return not self.items()

    @staticmethod
    def create(customer):
        return Order(customer)

    class Line:
        def price(self):
            return 0


def place_order(customer):
    order = Order.create(customer)
    return order.total()
