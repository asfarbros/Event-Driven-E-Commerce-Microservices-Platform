package com.ecommerce.orderservice.repository;

import com.ecommerce.orderservice.model.Order;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.UUID;

/**
 * Spring Data JPA repository for the Order entity.
 */
@Repository
public interface OrderRepository extends JpaRepository<Order, UUID> {

    /**
     * Find all orders placed by a specific user, newest first.
     */
    List<Order> findByUserIdOrderByCreatedAtDesc(String userId);
}
