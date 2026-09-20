package com.orderflow.inventory.domain;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import jakarta.persistence.Version;

/**
 * A time-limited hold on stock for ONE order (unique on order_id). Its lines
 * are {@link ReservationItem}s; they are held, confirmed or released together.
 */
@Entity
@Table(name = "reservation")
public class Reservation {

    @Id
    @Column(nullable = false)
    private UUID id;

    @Column(name = "order_id", nullable = false, length = 64)
    private String orderId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 16)
    private ReservationStatus status;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "created_by_request_id", length = 128)
    private String createdByRequestId;

    @Column(name = "resolved_at")
    private Instant resolvedAt;

    // Wrapper type on purpose: Spring Data treats a null version as "new
    // entity" and uses persist() instead of merge() (no extra SELECT), which
    // matters because both ids are assigned by the application, not the DB.
    @Version
    @Column(nullable = false)
    private Long version;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @OneToMany(mappedBy = "reservation", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    @OrderBy("productId ASC")
    private List<ReservationItem> items = new ArrayList<>();

    protected Reservation() {
    }

    public Reservation(String orderId, Instant expiresAt, String createdByRequestId) {
        this.id = UUID.randomUUID();
        this.orderId = orderId;
        this.status = ReservationStatus.HELD;
        this.expiresAt = expiresAt;
        this.createdByRequestId = createdByRequestId;
    }

    public ReservationItem addItem(String productId, int quantity) {
        ReservationItem item = new ReservationItem(this, productId, quantity);
        items.add(item);
        return item;
    }

    /** Leaves HELD for a terminal state. Caller checks {@link #isHeld()} first. */
    public void resolve(ReservationStatus terminal, Instant when) {
        if (!terminal.isTerminal()) {
            throw new IllegalArgumentException(terminal + " is not a terminal status");
        }
        if (status != ReservationStatus.HELD) {
            throw new IllegalStateException("reservation " + id + " is already " + status);
        }
        this.status = terminal;
        this.resolvedAt = when;
    }

    public boolean isHeld() {
        return status == ReservationStatus.HELD;
    }

    @PrePersist
    void onCreate() {
        Instant now = Instant.now();
        createdAt = now;
        updatedAt = now;
    }

    @PreUpdate
    void onUpdate() {
        updatedAt = Instant.now();
    }

    public UUID getId() {
        return id;
    }

    public String getOrderId() {
        return orderId;
    }

    public ReservationStatus getStatus() {
        return status;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    public String getCreatedByRequestId() {
        return createdByRequestId;
    }

    public Instant getResolvedAt() {
        return resolvedAt;
    }

    public Long getVersion() {
        return version;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }

    public List<ReservationItem> getItems() {
        return items;
    }
}
