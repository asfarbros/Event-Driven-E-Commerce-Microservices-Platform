package com.orderflow.payment.config;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class DotenvEnvironmentPostProcessorTest {

    @Test
    void parsesTheRootEnvGrammar() {
        Map<String, Object> values = DotenvEnvironmentPostProcessor.parse(List.of(
                "# comment",
                "",
                "PLAIN=value",
                "  SPACED  =  padded value  ",
                "QUOTED=\"-Xms256m -Xmx512m\"",
                "SINGLE='a # not a comment'",
                "TRAILING=abc # comment",
                "export EXPORTED=yes",
                "EMPTY=",
                "novalue",
                "URL=jdbc:postgresql://localhost:5432/inventory_db?x=1"));

        assertThat(values)
                .containsEntry("PLAIN", "value")
                .containsEntry("SPACED", "padded value")
                .containsEntry("QUOTED", "-Xms256m -Xmx512m")
                .containsEntry("SINGLE", "a # not a comment")
                .containsEntry("TRAILING", "abc")
                .containsEntry("EXPORTED", "yes")
                .containsEntry("EMPTY", "")
                .containsEntry("URL", "jdbc:postgresql://localhost:5432/inventory_db?x=1")
                .doesNotContainKey("novalue");
    }
}
