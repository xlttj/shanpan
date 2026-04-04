<?php

class OrderService
{
    public function createOrder(string $userId): int
    {
        return 0;
    }

    private function validateOrder(int $orderId): bool
    {
        return true;
    }
}

interface PaymentGateway
{
    public function charge(int $amount): bool;
}

function calculateTax(float $amount): float
{
    return $amount * 0.19;
}
