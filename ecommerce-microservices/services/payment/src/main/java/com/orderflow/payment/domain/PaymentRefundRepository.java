package com.orderflow.payment.domain;

import java.util.Optional;
import java.util.UUID;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

public interface PaymentRefundRepository extends JpaRepository<PaymentRefund, UUID> {

    Optional<PaymentRefund> findByPaymentId(UUID paymentId);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select r from PaymentRefund r where r.paymentId = :paymentId")
    Optional<PaymentRefund> lockByPaymentId(@Param("paymentId") UUID paymentId);

    Optional<PaymentRefund> findByRazorpayRefundId(String razorpayRefundId);
}
