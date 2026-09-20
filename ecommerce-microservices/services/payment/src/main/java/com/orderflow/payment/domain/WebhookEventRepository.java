package com.orderflow.payment.domain;

import java.util.Optional;

import org.springframework.data.jpa.repository.JpaRepository;

public interface WebhookEventRepository extends JpaRepository<WebhookEvent, Long> {

    Optional<WebhookEvent> findByProviderAndProviderEventId(String provider, String providerEventId);

    long countByProviderAndProviderEventId(String provider, String providerEventId);
}
