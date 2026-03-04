-- Pokémon Type Weakness & Resistance API Schema

CREATE TABLE IF NOT EXISTS generations (
  id   INT          NOT NULL,
  name VARCHAR(50)  NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS types (
  id   INT          NOT NULL,
  name VARCHAR(50)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_type_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Attacking type vs defending type effectiveness per generation.
-- Only rows where multiplier != 1 are stored; missing rows imply 1x.
CREATE TABLE IF NOT EXISTS type_effectiveness (
  generation_id      INT            NOT NULL,
  attacking_type_id  INT            NOT NULL,
  defending_type_id  INT            NOT NULL,
  multiplier         DECIMAL(5,4)   NOT NULL,
  PRIMARY KEY (generation_id, attacking_type_id, defending_type_id),
  CONSTRAINT fk_te_gen  FOREIGN KEY (generation_id)     REFERENCES generations(id),
  CONSTRAINT fk_te_atk  FOREIGN KEY (attacking_type_id) REFERENCES types(id),
  CONSTRAINT fk_te_def  FOREIGN KEY (defending_type_id) REFERENCES types(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS pokemon (
  id         INT           NOT NULL,
  identifier VARCHAR(100)  NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_identifier (identifier)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pokémon names in multiple languages (en, de)
CREATE TABLE IF NOT EXISTS pokemon_names (
  pokemon_id  INT          NOT NULL,
  language    VARCHAR(10)  NOT NULL,
  name        VARCHAR(100) NOT NULL,
  PRIMARY KEY (pokemon_id, language),
  CONSTRAINT fk_pn_pokemon FOREIGN KEY (pokemon_id) REFERENCES pokemon(id),
  INDEX idx_pn_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pokémon types per generation (slot 1 or 2)
CREATE TABLE IF NOT EXISTS pokemon_types (
  pokemon_id    INT  NOT NULL,
  generation_id INT  NOT NULL,
  slot          INT  NOT NULL,
  type_id       INT  NOT NULL,
  PRIMARY KEY (pokemon_id, generation_id, slot),
  CONSTRAINT fk_pt_pokemon FOREIGN KEY (pokemon_id)    REFERENCES pokemon(id),
  CONSTRAINT fk_pt_gen     FOREIGN KEY (generation_id) REFERENCES generations(id),
  CONSTRAINT fk_pt_type    FOREIGN KEY (type_id)        REFERENCES types(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
